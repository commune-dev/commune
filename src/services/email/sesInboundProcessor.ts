/**
 * SES inbound email processor.
 *
 * Polls SQS for SNS notifications from SES Receipt Rules.
 * Each notification points to a .eml file in S3. We:
 *   1. Fetch the .eml from S3
 *   2. Parse it with mailparser
 *   3. Run the full inbound pipeline (spam, prompt injection, extraction, webhooks, etc.)
 *
 * This replaces the Resend inbound webhook + getReceivedEmail() + listReceivedAttachments()
 * calls. All email content is extracted inline from the raw .eml.
 */

import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { simpleParser } from 'mailparser';
import messageStore from '../../stores/messageStore';
import suppressionStore from '../../stores/suppressionStore';
import domainStore from '../../stores/domainStore';
import { StructuredExtractionService } from '../structuredExtractionService';
import { AttachmentStorageService } from '../attachmentStorageService';
import type { AttachmentRecord } from '../../types';
import { EmailProcessor } from '../emailProcessor';
import { SpamDetectionService } from '../spam/spamDetectionService';
import { AttachmentScannerService } from '../security/attachmentScannerService';
import reputationStore from '../../stores/reputationStore';
import blockedSpamStore from '../../stores/blockedSpamStore';
import { PromptInjectionDetector } from '../security/promptInjectionDetector';
import { resolveOrgTier } from '../../lib/tierResolver';
import { hasFeature } from '../../config/rateLimits';
import { registerThreadToken } from '../../lib/threadToken';
import webhookDeliveryService from '../webhookDeliveryService';
import realtimeService from '../realtimeService';
import { scheduleGraphExtraction } from '../graphExtractionService';
import metricsCacheService from '../metricsCacheService';
import sesClient from '../sesClient';
import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import {
  normalizeRecipient,
  isWebhookDuplicate,
} from './helpers';
import { normalizeEmail, collectSmtpCandidates } from './normalize';
import logger from '../../utils/logger';

const SQS_QUEUE_URL = process.env.SES_INBOUND_QUEUE_URL
  || 'https://sqs.us-east-1.amazonaws.com/265230572969/commune-email-processing';
const S3_BUCKET = process.env.SES_INBOUND_BUCKET || 'commune-inbound-emails';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

const sqsClient = new SQSClient({ region: AWS_REGION });
const s3Client = new S3Client({ region: AWS_REGION });

let polling = false;
let pollInterval: ReturnType<typeof setInterval> | null = null;

// ─── SQS Polling ─────────────────────────────────────────────────────────────

export const startInboundPoller = () => {
  if (pollInterval) return;
  logger.info('SES inbound poller started', { queue: SQS_QUEUE_URL });
  pollInterval = setInterval(poll, 5000);
  poll(); // kick off immediately
};

export const stopInboundPoller = () => {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    logger.info('SES inbound poller stopped');
  }
};

const poll = async () => {
  if (polling) return;
  polling = true;
  try {
    const res = await sqsClient.send(new ReceiveMessageCommand({
      QueueUrl: SQS_QUEUE_URL,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 20, // long-poll
      VisibilityTimeout: 120,
    }));

    const messages = res.Messages || [];
    await Promise.allSettled(messages.map(processQueueMessage));
  } catch (err) {
    logger.error('SQS poll error', { error: err });
  } finally {
    polling = false;
  }
};

const processQueueMessage = async (sqsMessage: { Body?: string; ReceiptHandle?: string }) => {
  try {
    if (!sqsMessage.Body) return;

    // SQS message body is an SNS notification JSON
    const snsEnvelope = JSON.parse(sqsMessage.Body);
    const notification = JSON.parse(snsEnvelope.Message || '{}');

    // SES Receipt Rule notification structure
    const sesNotification = notification?.mail;
    const receipt = notification?.receipt;
    if (!sesNotification) {
      logger.debug('Non-SES message in queue, skipping');
      await deleteSqsMessage(sqsMessage.ReceiptHandle!);
      return;
    }

    const messageId = sesNotification.messageId as string;
    if (!messageId) {
      logger.warn('SES notification missing messageId');
      await deleteSqsMessage(sqsMessage.ReceiptHandle!);
      return;
    }

    // Idempotency
    const dedupKey = `ses:inbound:${messageId}`;
    if (await isWebhookDuplicate(dedupKey)) {
      logger.debug('Duplicate inbound message skipped', { messageId });
      await deleteSqsMessage(sqsMessage.ReceiptHandle!);
      return;
    }

    // Get spam verdict from SES (pre-filter)
    const spamVerdict = receipt?.spamVerdict?.status;
    if (spamVerdict === 'FAIL') {
      logger.info('SES pre-rejected spam', { messageId });
      await deleteSqsMessage(sqsMessage.ReceiptHandle!);
      return;
    }

    // Fetch raw .eml from S3
    const s3Key = `inbound/${messageId}`;
    const s3Res = await s3Client.send(new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
    }));
    const emlBuffer = Buffer.from(await streamToBuffer(s3Res.Body as any));

    // Parse with mailparser
    const parsed = await simpleParser(emlBuffer);

    await processInboundEmail(parsed, messageId, sesNotification);
    await deleteSqsMessage(sqsMessage.ReceiptHandle!);
  } catch (err) {
    logger.error('Failed to process SQS message', { error: err });
    // Don't delete — let it go to DLQ after maxReceiveCount retries
  }
};

const deleteSqsMessage = async (receiptHandle: string) => {
  await sqsClient.send(new DeleteMessageCommand({
    QueueUrl: SQS_QUEUE_URL,
    ReceiptHandle: receiptHandle,
  }));
};

const streamToBuffer = async (stream: any): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.length;
  }
  return buf;
};

// ─── Inbound Email Processing ─────────────────────────────────────────────────

const processInboundEmail = async (parsed: Awaited<ReturnType<typeof simpleParser>>, sesMessageId: string, sesNotification: Record<string, any>) => {
  const toList = parsed.to
    ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]).flatMap((a: any) => a.value || []).map((a: any) => a.address).filter(Boolean)
    : [];

  const parsedRecipients = toList.map(normalizeRecipient).filter(Boolean) as Array<NonNullable<ReturnType<typeof normalizeRecipient>>>;
  const primary = parsedRecipients[0] || null;
  const recipientDomain = primary?.domain || null;

  // Resolve domain + inbox
  const [domainEntryByName] = await Promise.all([
    recipientDomain ? domainStore.getDomainByName(recipientDomain) : Promise.resolve(null),
  ]);
  const resolvedDomain = domainEntryByName || null;
  const resolvedDomainId = resolvedDomain?.id || null;
  const resolvedDomainName = (resolvedDomain?.name || recipientDomain || '').toLowerCase();

  const matchingRecipient = resolvedDomainName
    ? parsedRecipients.find((addr) => addr.domain === resolvedDomainName)?.raw
    : primary?.raw;

  const localPart = matchingRecipient ? normalizeRecipient(matchingRecipient)?.localPartBase || null : null;
  const inbox = localPart && resolvedDomainId
    ? await domainStore.getInboxByLocalPart(resolvedDomainId, localPart)
    : null;

  // Build normalized email object (same shape as Resend's getReceivedEmail response)
  const fromAddress = (parsed.from?.value?.[0]?.address) || '';
  const emailSubject = parsed.subject || '';
  const emailText = parsed.text || '';
  const emailHtml = parsed.html || undefined;
  const emailHeaders: Record<string, string> = {};
  parsed.headers.forEach((value, key) => {
    emailHeaders[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  });

  const email: Record<string, any> = {
    id: sesMessageId,
    message_id: sesMessageId,
    from: fromAddress,
    to: toList,
    subject: emailSubject,
    text: emailText,
    html: emailHtml,
    headers: emailHeaders,
    created_at: (parsed.date || new Date()).toISOString(),
  };

  // Process attachments
  const attachments: AttachmentRecord[] = [];
  const attachmentStorageService = AttachmentStorageService.getInstance();
  const scanner = AttachmentScannerService.getInstance();

  for (const att of parsed.attachments || []) {
    if (!att.content) continue;
    const buf = att.content;
    const filename = att.filename || 'attachment';
    const contentType = att.contentType || 'application/octet-stream';
    const attachmentId = `ses_${sesMessageId}_${filename}`;

    try {
      const scanResult = await scanner.scanAttachment(buf, filename, contentType, inbox?.orgId);
      if (!scanResult.safe) {
        attachments.push({
          attachment_id: attachmentId,
          message_id: sesMessageId,
          filename,
          mime_type: contentType,
          size: buf.length,
          content_base64: null,
          source: 'email',
          storage_type: 'database',
          quarantined: true,
          scan_threats: scanResult.threats,
        } as any);
        continue;
      }

      const uploadResult = await attachmentStorageService.uploadAttachment(buf, filename, contentType, inbox?.orgId);
      attachments.push({
        attachment_id: attachmentId,
        message_id: sesMessageId,
        filename,
        mime_type: contentType,
        size: buf.length,
        content_base64: uploadResult.storage_type === 'database' ? buf.toString('base64') : null,
        storage_type: uploadResult.storage_type,
        cloudinary_url: uploadResult.cloudinary_url || null,
        cloudinary_public_id: uploadResult.cloudinary_public_id || null,
        source: 'email',
      });
    } catch (err) {
      logger.error('Failed to process attachment', { filename, error: err });
      attachments.push({
        attachment_id: attachmentId,
        message_id: sesMessageId,
        filename,
        mime_type: contentType,
        size: buf.length,
        content_base64: null,
        download_error: true,
        source: 'email',
        storage_type: 'database',
      });
    }
  }

  // Spam detection
  const spamDetectionService = SpamDetectionService.getInstance();
  const spamAnalysis = await spamDetectionService.analyzeEmail({
    from: fromAddress,
    to: parsedRecipients.map(r => r.normalized),
    subject: emailSubject,
    content: emailText,
    html: emailHtml,
    headers: emailHeaders,
  }, inbox?.orgId);

  if (spamAnalysis.action === 'reject') {
    logger.info('Email rejected as spam', { from: fromAddress, reasons: spamAnalysis.reasons });
    const senderDomain = fromAddress.split('@')[1] || '';
    setImmediate(async () => {
      try {
        await blockedSpamStore.storeBlockedEmail({
          org_id: inbox?.orgId || 'unknown',
          inbox_id: inbox?.id,
          sender_email: fromAddress,
          sender_domain: senderDomain,
          subject: emailSubject,
          blocked_at: new Date(),
          spam_score: spamAnalysis.spam_score,
          reasons: spamAnalysis.reasons,
          classification: spamAnalysis.reasons.some(r => r.includes('Mass email attack')) ? 'mass_attack'
            : spamAnalysis.reasons.some(r => r.toLowerCase().includes('phishing')) ? 'phishing' : 'spam',
          metadata: {
            to: parsedRecipients.map(r => r.normalized),
            content_preview: (emailText || emailHtml || '').substring(0, 200),
            url_count: ((emailText || emailHtml || '').match(/(https?:\/\/[^\s]+)/gi) || []).length,
            has_attachments: attachments.length > 0,
            sender_reputation: spamAnalysis.details?.sender_reputation ?? 0,
            domain_reputation: spamAnalysis.details?.domain_reputation ?? 0,
          },
        });
      } catch (err) {
        logger.error('Rejection logging failed', { error: err });
      }
    });
    return;
  }

  // Thread resolution
  const smtpCandidates = collectSmtpCandidates(emailHeaders);
  const dbResolvedThreadId = smtpCandidates.length > 0
    ? await messageStore.resolveThreadBySmtpIds(smtpCandidates, inbox?.orgId)
    : null;

  // Routing token from plus-address
  const plusMatch = matchingRecipient?.match(/\+([^@]+)@/);
  const rawRoutingToken = plusMatch?.[1] || null;

  const { message } = normalizeEmail({
    email,
    domainId: resolvedDomainId || 'unknown-domain',
    inboxId: inbox?.id || null,
    inboxAddress: inbox?.address || matchingRecipient || null,
    attachments,
    resolvedThreadId: dbResolvedThreadId,
  });

  if (rawRoutingToken) {
    const dbThreadId = await messageStore.resolveThreadByRoutingToken(rawRoutingToken, inbox?.orgId);
    if (dbThreadId) {
      message.thread_id = dbThreadId;
      registerThreadToken(rawRoutingToken, dbThreadId);
    }
  }

  // Spam metadata
  message.metadata.spam_checked = true;
  message.metadata.spam_score = spamAnalysis.spam_score;
  message.metadata.spam_action = spamAnalysis.action;
  if (spamAnalysis.action === 'flag') {
    message.metadata.spam_flagged = true;
    message.metadata.spam_reasons = spamAnalysis.reasons;
  }

  // Prompt injection detection
  const orgIdForSecurity = inbox?.orgId || resolvedDomain?.orgId;
  const orgTier = await resolveOrgTier(orgIdForSecurity);
  const allowLlmAdjudicator = hasFeature(orgTier, 'promptInjection');
  const injectionDetector = PromptInjectionDetector.getInstance();
  const injectionAnalysis = await injectionDetector.analyze(emailText, emailHtml, emailSubject, { enableAdjudicator: allowLlmAdjudicator });

  message.metadata.prompt_injection_checked = true;
  message.metadata.prompt_injection_detected = injectionAnalysis.detected;
  message.metadata.prompt_injection_risk = injectionAnalysis.risk_level;
  message.metadata.prompt_injection_score = injectionAnalysis.confidence;
  message.metadata.prompt_injection_model_checked = injectionAnalysis.model_checked;
  message.metadata.prompt_injection_model_provider = injectionAnalysis.model_provider;
  message.metadata.prompt_injection_model_version = injectionAnalysis.model_version;
  message.metadata.prompt_injection_model_score = injectionAnalysis.model_score;
  message.metadata.prompt_injection_model_error = injectionAnalysis.model_error;
  message.metadata.prompt_injection_model_tier = orgTier;
  message.metadata.prompt_injection_model_allowed = allowLlmAdjudicator;
  message.metadata.prompt_injection_fusion_score = injectionAnalysis.fusion_score;
  message.metadata.prompt_injection_fusion_version = injectionAnalysis.fusion_version;
  message.metadata.prompt_injection_reason_codes = injectionAnalysis.reason_codes;
  message.metadata.prompt_injection_disagreement = injectionAnalysis.disagreement;
  if (injectionAnalysis.detected) {
    message.metadata.prompt_injection_signals = injectionAnalysis.summary;
  }

  // Vector indexing (fire-and-forget)
  if (spamAnalysis.action === 'accept') {
    EmailProcessor.getInstance().processMessage(message).catch(err =>
      logger.error('Vector indexing failed', { messageId: message.message_id, error: err })
    );
  }

  await reputationStore.incrementEmailCount(fromAddress);

  // Structured extraction
  let extractedData: Record<string, any> | null = null;
  if (inbox?.extractionSchema?.enabled) {
    try {
      const conversationMessages = message.thread_id
        ? await messageStore.getThreadMessages(message.thread_id, inbox.orgId)
        : [];

      if (conversationMessages.length > 0) {
        const conversationData = conversationMessages.map((msg: any) => ({
          from: msg.participants.find((p: any) => p.role === 'sender')?.identity || '',
          to: msg.participants.find((p: any) => p.role === 'to')?.identity || '',
          subject: msg.metadata.subject || '',
          body: msg.content || '',
          date: msg.created_at,
          messageId: msg.message_id,
        }));
        conversationData.push({
          from: fromAddress,
          to: matchingRecipient || '',
          subject: emailSubject,
          body: emailText || emailHtml || '',
          date: message.created_at,
          messageId: message.message_id,
        });
        extractedData = await StructuredExtractionService.extractFromConversation(
          conversationData, inbox.extractionSchema.schema, inbox.extractionSchema.name
        );
      } else {
        extractedData = await StructuredExtractionService.extractFromEmail(
          { from: fromAddress, to: matchingRecipient || '', subject: emailSubject, body: emailText || emailHtml || '', date: email.created_at, messageId: email.message_id },
          inbox.extractionSchema.schema, inbox.extractionSchema.name
        );
      }
      if (extractedData) message.metadata.extracted_data = extractedData;
    } catch (err) {
      logger.error('Structured extraction failed', { inboxId: inbox.id, error: err });
    }
  }

  const finalOrgId = inbox?.orgId || resolvedDomain?.orgId;
  await messageStore.insertMessage({ ...message, orgId: finalOrgId });
  await messageStore.insertAttachments(attachments);
  logger.info('Inbound email stored', { messageId: message.message_id, threadId: message.thread_id });

  // Personal inbox forwarding: shanjai@commune.email → shanjairajdev@gmail.com
  if (localPart === 'shanjai' && resolvedDomainName === 'commune.email') {
    setImmediate(async () => {
      try {
        await sesClient.send(new SendEmailCommand({
          FromEmailAddress: 'shanjai@commune.email',
          Destination: { ToAddresses: ['shanjairajdev@gmail.com'] },
          ReplyToAddresses: [fromAddress],
          Content: {
            Simple: {
              Subject: { Data: emailSubject, Charset: 'UTF-8' },
              Body: emailHtml
                ? { Html: { Data: emailHtml, Charset: 'UTF-8' } }
                : { Text: { Data: emailText, Charset: 'UTF-8' } },
            },
          },
          ConfigurationSetName: 'commune-sending',
        }));
        logger.info('Personal email forwarded', { subject: emailSubject });
      } catch (err) {
        logger.error('Personal email forward failed', { error: err });
      }
    });
  }

  // Graph extraction
  if (hasFeature(orgTier, 'networkGraph')) {
    scheduleGraphExtraction(message.thread_id, finalOrgId);
  }

  // Real-time push
  if (finalOrgId) {
    realtimeService.emit(finalOrgId, {
      type: 'email.received',
      inbox_id: inbox?.id || null,
      inbox_address: inbox?.address || matchingRecipient || null,
      thread_id: message.thread_id,
      message_id: message.message_id,
      subject: message.metadata?.subject || '(no subject)',
      from: fromAddress || null,
      direction: 'inbound',
      created_at: message.created_at,
    } as any);
  }

  // Inbox webhook delivery
  if (inbox?.webhook?.endpoint) {
    const derivedDomainId = await domainStore.getDomainIdByInboxId(inbox.id);
    const outboundPayload = {
      domainId: derivedDomainId || resolvedDomainId,
      inboxId: inbox.id,
      inboxAddress: inbox.address || matchingRecipient,
      event: { type: 'email.received', data: { email_id: sesMessageId } },
      email,
      message,
      extractedData: extractedData || undefined,
      attachments: attachments.map(att => ({
        attachment_id: att.attachment_id,
        filename: att.filename,
        mime_type: att.mime_type,
        size: att.size,
      })),
      security: {
        spam: { checked: true, score: spamAnalysis.spam_score, action: spamAnalysis.action, flagged: spamAnalysis.action === 'flag' },
        prompt_injection: {
          checked: true, detected: injectionAnalysis.detected,
          risk_level: injectionAnalysis.risk_level, confidence: injectionAnalysis.confidence,
          summary: injectionAnalysis.detected ? injectionAnalysis.summary : undefined,
          model_checked: injectionAnalysis.model_checked, model_provider: injectionAnalysis.model_provider,
          model_version: injectionAnalysis.model_version, model_score: injectionAnalysis.model_score,
          model_error: injectionAnalysis.model_error, model_tier: orgTier, model_allowed: allowLlmAdjudicator,
          fusion_score: injectionAnalysis.fusion_score, fusion_version: injectionAnalysis.fusion_version,
          reason_codes: injectionAnalysis.reason_codes, disagreement: injectionAnalysis.disagreement,
        },
      },
    };

    webhookDeliveryService.deliverWebhook({
      inbox_id: inbox.id,
      org_id: inbox.orgId,
      message_id: message.message_id,
      endpoint: inbox.webhook.endpoint,
      payload: outboundPayload,
      webhook_secret: inbox.webhook.secret,
    }).catch((err) => {
      logger.error('Webhook delivery failed', { inboxId: inbox.id, error: err });
    });
  }

  if (inbox?.id) {
    metricsCacheService.clearInboxCache(inbox.id);
  }
};
