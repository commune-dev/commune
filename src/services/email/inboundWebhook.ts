import resendHttp from '../resendHttp';
import resend from '../resendClient';
import { verifyWebhook } from '../../lib/verifySvix';
import messageStore from '../../stores/messageStore';
import { normalizeEmail, collectSmtpCandidates } from './normalize';
import domainStore from '../../stores/domainStore';
import { StructuredExtractionService } from '../structuredExtractionService';
import { AttachmentStorageService } from '../attachmentStorageService';
import type { SvixHeaders, AttachmentRecord } from '../../types';
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
import {
  normalizeRecipient,
  inferDomainFromPayload,
  ensureWebhookSecret,
  isWebhookDuplicate,
} from './helpers';
import { handleDeliveryEvent } from './deliveryEvents';
import logger from '../../utils/logger';

const handleInboundWebhook = async ({
  domainId,
  payload,
  headers,
}: {
  domainId?: string;
  payload: string;
  headers: SvixHeaders;
}) => {
  // Idempotency check: skip if we've already processed this webhook event
  if (headers.id) {
    let dedupKey = headers.id; // fallback for non-email events
    try {
      const parsedPayload = JSON.parse(payload);
      if (parsedPayload?.type === 'email.received' && parsedPayload?.data?.email_id) {
        dedupKey = `email:${parsedPayload.data.email_id}`;
      }
    } catch {
      // malformed payload — keep svix-id as key; signature check will reject it
    }
    const isDuplicate = await isWebhookDuplicate(dedupKey);
    if (isDuplicate) {
      logger.debug('Duplicate webhook skipped', { dedupKey });
      return { data: { duplicate: true, svix_id: headers.id } };
    }
  }

  const { domainId: inferredDomainId, domainEntry: inferredDomainEntry, threadTag, rawRoutingToken } =
    await inferDomainFromPayload(payload, domainId);
  const domainToUse = inferredDomainId || domainId;
  if (!domainToUse) {
    return { error: { message: 'Unknown domain for webhook payload' } };
  }
  const secret = await ensureWebhookSecret(domainToUse);
  if (!secret) {
    return { error: { message: 'Unknown domain or webhook secret' } };
  }

  let event: any;
  try {
    event = verifyWebhook(payload, headers, secret);
  } catch (error) {
    logger.warn('Webhook signature verification failed', { svixId: headers.id });
    return { error: { message: 'Invalid signature' } };
  }

  if (event.type === 'email.received') {
    const [emailResult, attachmentsResult] = await Promise.all([
      resendHttp.getReceivedEmail(event.data.email_id),
      resendHttp.listReceivedAttachments(event.data.email_id),
    ]);

    const { data: email, error: emailError } = emailResult;
    if (emailError) {
      return { error: emailError };
    }

    const { data: attachmentList, error: attachmentError } = attachmentsResult;
    if (attachmentError) {
      logger.error('Failed to fetch attachments from Resend', { error: attachmentError });
      return { error: attachmentError };
    }

    // Resolve recipient, domain, and inbox first
    const toList = Array.isArray((email as any).to) ? (email as any).to : [];
    const parsedRecipients = toList.map(normalizeRecipient).filter(Boolean) as Array<
      NonNullable<ReturnType<typeof normalizeRecipient>>
    >;

    const primary = parsedRecipients[0] || null;
    const recipientDomain = primary?.domain || null;


    // PRIORITY 1: Find domain by recipient email domain (parallelized)
    const [domainEntryByName, domainEntryById] = await Promise.all([
      recipientDomain ? domainStore.getDomainByName(recipientDomain) : Promise.resolve(null),
      inferredDomainId ? domainStore.getDomain(inferredDomainId) : Promise.resolve(null),
    ]);
    const resolvedDomain = domainEntryByName || domainEntryById || inferredDomainEntry || null;
    const resolvedDomainId =
      resolvedDomain?.id || inferredDomainId || domainId || null;
    const resolvedDomainName = (
      resolvedDomain?.name ||
      recipientDomain ||
      ''
    ).toLowerCase();


    const matchingRecipient = resolvedDomainName
      ? parsedRecipients.find((addr) => addr.domain === resolvedDomainName)?.raw
      : primary?.raw;

    const localPart = matchingRecipient ? normalizeRecipient(matchingRecipient)?.localPartBase || null : null;
    const inbox =
      localPart && resolvedDomainId
        ? await domainStore.getInboxByLocalPart(resolvedDomainId, localPart)
        : null;


    const attachments: AttachmentRecord[] = [];
    const attachmentStorageService = AttachmentStorageService.getInstance();
    
    if (attachmentList && Array.isArray((attachmentList as any).data)) {
      logger.debug('Processing attachments', { count: (attachmentList as any).data.length });
      for (const attachment of (attachmentList as any).data) {
        if (!attachment.download_url) {
          attachments.push(attachment as AttachmentRecord);
          continue;
        }

        try {
          const response = await fetch(attachment.download_url as string);
          if (!response.ok) {
            throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
          }
          const buffer = Buffer.from(await response.arrayBuffer());
          const base64Content = buffer.toString('base64');

          // Scan attachment for threats before storing
          const scanner = AttachmentScannerService.getInstance();
          const scanResult = await scanner.scanAttachment(
            buffer,
            attachment.filename,
            attachment.content_type,
            inbox?.orgId
          );
          
          if (!scanResult.safe) {
            logger.warn('Attachment quarantined', {
              filename: attachment.filename,
              threats: scanResult.threats,
              method: scanResult.scan_method,
            });
            attachments.push({
              attachment_id: attachment.id,
              message_id: (email as any).message_id,
              filename: attachment.filename,
              mime_type: attachment.content_type,
              size: attachment.size,
              content_base64: null,
              source: 'email',
              storage_type: 'database',
              quarantined: true,
              scan_threats: scanResult.threats,
            } as any);
            continue;
          }

          
          // Upload to Cloudinary or store as base64
          const uploadResult = await attachmentStorageService.uploadAttachment(
            buffer,
            attachment.filename,
            attachment.content_type,
            inbox?.orgId
          );
          
          
          attachments.push({
            attachment_id: attachment.id,
            message_id: (email as any).message_id,
            filename: attachment.filename,
            mime_type: attachment.content_type,
            size: attachment.size,
            content_base64: uploadResult.storage_type === 'database' ? base64Content : (uploadResult.content_base64 || null),
            storage_type: uploadResult.storage_type,
            cloudinary_url: uploadResult.cloudinary_url || null,
            cloudinary_public_id: uploadResult.cloudinary_public_id || null,
            source: 'email',
          });
        } catch (error) {
          logger.error('Failed to process attachment', { filename: attachment.filename, error });
          attachments.push({
            attachment_id: attachment.id,
            message_id: (email as any).message_id,
            filename: attachment.filename,
            mime_type: attachment.content_type,
            size: attachment.size,
            content_base64: null,
            download_error: true,
            source: 'email',
            storage_type: 'database',
          });
        }
      }
    } else {
      logger.debug('No attachments in response');
    }

    logger.debug('Attachments processed', { count: attachments.length });

    const domainForNormalize = resolvedDomainId || domainId || 'unknown-domain';

    // SPAM DETECTION - Check before processing
    const spamDetectionService = SpamDetectionService.getInstance();
    const fromEmail = (email as any).from || '';
    const emailContent = (email as any).text || '';
    const emailHtml = (email as any).html;
    const emailSubject = (email as any).subject || '';
    
    const spamAnalysis = await spamDetectionService.analyzeEmail({
      from: fromEmail,
      to: parsedRecipients.map(r => r.normalized),
      subject: emailSubject,
      content: emailContent,
      html: emailHtml,
      headers: (email as any).headers || {},
    }, inbox?.orgId);

    logger.info('Spam analysis completed', {
      from: fromEmail,
      action: spamAnalysis.action,
      score: spamAnalysis.spam_score,
      processing_time_ms: spamAnalysis.processing_time_ms,
    });

    // REJECT: Don't store, don't forward
    if (spamAnalysis.action === 'reject') {
      logger.info('Email rejected as spam', {
        from: fromEmail,
        reasons: spamAnalysis.reasons,
      });

      // Store blocked spam email for tracking (fire-and-forget — return immediately to prevent retries)
      const senderDomain = fromEmail.split('@')[1] || '';
      const contentPreview = (emailContent || emailHtml || '').substring(0, 200);
      const urlCount = ((emailContent || emailHtml || '').match(/(https?:\/\/[^\s]+)/gi) || []).length;

      setImmediate(async () => {
        try {
          await blockedSpamStore.storeBlockedEmail({
            org_id: inbox?.orgId || 'unknown',
            inbox_id: inbox?.id,
            sender_email: fromEmail,
            sender_domain: senderDomain,
            subject: emailSubject,
            blocked_at: new Date(),
            spam_score: spamAnalysis.spam_score,
            reasons: spamAnalysis.reasons,
            classification: spamAnalysis.reasons.some(r => r.includes('Mass email attack'))
              ? 'mass_attack'
              : spamAnalysis.reasons.some(r => r.toLowerCase().includes('phishing'))
              ? 'phishing'
              : 'spam',
            metadata: {
              to: parsedRecipients.map(r => r.normalized),
              content_preview: contentPreview,
              url_count: urlCount,
              has_attachments: attachments.length > 0,
              sender_reputation: spamAnalysis.details.sender_reputation,
              domain_reputation: spamAnalysis.details.domain_reputation,
            },
          });
          await reputationStore.updateSpamScore(fromEmail, {
            spam_reports: (await reputationStore.getSpamScore(fromEmail))?.spam_reports || 0 + 1,
            last_email_at: new Date(),
          });
        } catch (err) {
          logger.error('Rejection logging failed', { error: err });
        }
      });
      return { data: { rejected: true, reason: 'spam' } };
    }

    // DB-backed thread resolution: look up stored messages by SMTP References/In-Reply-To
    // to find the correct thread_id before falling back to SMTP-header-derived IDs.
    const emailHeaders = ((email as any).headers || {}) as Record<string, string>;
    const smtpCandidates = collectSmtpCandidates(emailHeaders);

    logger.debug('Thread resolution — SMTP candidates', {
      in_reply_to: emailHeaders['in-reply-to'] || null,
      references: emailHeaders.references || null,
      candidates: smtpCandidates,
      threadTag,
      rawRoutingToken,
    });

    const dbResolvedThreadId = smtpCandidates.length > 0
      ? await messageStore.resolveThreadBySmtpIds(smtpCandidates, inbox?.orgId)
      : null;

    logger.debug('Thread resolution result', {
      dbResolvedThreadId,
      willUseThreadTag: !!threadTag,
      willUseRoutingToken: !threadTag && !!rawRoutingToken,
    });

    const { message } = normalizeEmail({
      email: email as Record<string, any>,
      domainId: domainForNormalize,
      inboxId: inbox?.id || null,
      inboxAddress: inbox?.address || matchingRecipient || null,
      attachments,
      resolvedThreadId: dbResolvedThreadId,
    });
    // Thread tag from plus-addressed Reply-To takes highest priority
    // (it's our own routing token, guaranteed correct)
    if (threadTag) {
      message.thread_id = threadTag;
    } else if (rawRoutingToken) {
      // Short token was in the address but not in the in-memory cache (server restarted).
      // Do a DB fallback lookup by the stored routing_token field.
      const dbThreadId = await messageStore.resolveThreadByRoutingToken(rawRoutingToken, inbox?.orgId);
      if (dbThreadId) {
        message.thread_id = dbThreadId;
        // Re-populate the in-memory cache for future lookups
        registerThreadToken(rawRoutingToken, dbThreadId);
      }
    }

    // Add spam metadata to message
    message.metadata.spam_checked = true;
    message.metadata.spam_score = spamAnalysis.spam_score;
    message.metadata.spam_action = spamAnalysis.action;
    
    if (spamAnalysis.action === 'flag') {
      message.metadata.spam_flagged = true;
      message.metadata.spam_reasons = spamAnalysis.reasons;
    }

    // PROMPT INJECTION DETECTION — Protect AI agents consuming email via webhooks
    const orgIdForSecurity = inbox?.orgId || resolvedDomain?.orgId;
    const orgTier = await resolveOrgTier(orgIdForSecurity);
    const allowLlmAdjudicator = hasFeature(orgTier, 'promptInjection');

    const injectionDetector = PromptInjectionDetector.getInstance();
    const injectionAnalysis = await injectionDetector.analyze(
      emailContent,
      emailHtml,
      emailSubject,
      { enableAdjudicator: allowLlmAdjudicator }
    );

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
      logger.warn('Prompt injection detected', {
        from: fromEmail,
        risk_level: injectionAnalysis.risk_level,
        confidence: injectionAnalysis.confidence,
        summary: injectionAnalysis.summary,
      });
    }

    // Only index and forward if not flagged as spam
    if (spamAnalysis.action === 'accept') {
      // Index for vector search (fire-and-forget — don't block the response path)
      EmailProcessor.getInstance().processMessage(message).catch(err =>
        logger.error('Vector indexing failed', { messageId: message.message_id, error: err })
      );
    }

    // Update sender reputation (positive signal)
    await reputationStore.incrementEmailCount(fromEmail);

    // Structured data extraction
    let extractedData: Record<string, any> | null = null;
    if (inbox?.extractionSchema && inbox.extractionSchema.enabled) {
      logger.debug('Extraction schema detected for inbox', {
        inboxId: inbox.id,
        schemaName: inbox.extractionSchema.name,
      });

      try {
        // Check if this is part of a conversation thread
        const conversationMessages = message.thread_id
          ? await messageStore.getThreadMessages(message.thread_id, inbox.orgId)
          : [];

        if (conversationMessages.length > 0) {
          // Extract from full conversation context
          const conversationData = conversationMessages.map((msg: any) => ({
            from: msg.participants.find((p: any) => p.role === 'sender')?.identity || '',
            to: msg.participants.find((p: any) => p.role === 'to')?.identity || '',
            subject: msg.metadata.subject || '',
            body: msg.content || '',
            date: msg.created_at,
            messageId: msg.message_id,
          }));

          // Add current message to conversation
          conversationData.push({
            from: (email as any).from || '',
            to: matchingRecipient || '',
            subject: (email as any).subject || '',
            body: (email as any).text || (email as any).html || '',
            date: message.created_at,
            messageId: message.message_id,
          });

          extractedData = await StructuredExtractionService.extractFromConversation(
            conversationData,
            inbox.extractionSchema.schema,
            inbox.extractionSchema.name
          );
        } else {
          // Extract from single email
          extractedData = await StructuredExtractionService.extractFromEmail(
            {
              from: (email as any).from || '',
              to: matchingRecipient || '',
              subject: (email as any).subject || '',
              body: (email as any).text || (email as any).html || '',
              date: (email as any).created_at,
              messageId: (email as any).message_id,
            },
            inbox.extractionSchema.schema,
            inbox.extractionSchema.name
          );
        }

        if (extractedData) {
          logger.info('Structured data extracted', {
            inboxId: inbox.id,
            schemaName: inbox.extractionSchema.name,
            extractedFields: Object.keys(extractedData),
          });
          message.metadata.extracted_data = extractedData;
        }
      } catch (error) {
        logger.error('Structured extraction failed', {
          inboxId: inbox.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const finalOrgId = inbox?.orgId || resolvedDomain?.orgId;
    await messageStore.insertMessage({
      ...message,
      orgId: finalOrgId,
    });
    await messageStore.insertAttachments(attachments);
    logger.info('Inbound email stored', { messageId: message.message_id, threadId: message.thread_id });

    // Personal inbox forwarding: shanjai@commune.email → shanjairajdev@gmail.com
    if (localPart === 'shanjai' && resolvedDomainName === 'commune.email') {
      const originalFrom = (email as any).from || '';
      const originalSubject = (email as any).subject || '(no subject)';
      const originalText = (email as any).text || '';
      const originalHtml = (email as any).html || '';
      setImmediate(async () => {
        try {
          await resend.emails.send({
            from: 'shanjai@commune.email',
            to: ['shanjairajdev@gmail.com'],
            subject: originalSubject,
            ...(originalHtml ? { html: originalHtml } : { text: originalText }),
            reply_to: originalFrom,
          });
          logger.info('Personal email forwarded', { subject: originalSubject });
        } catch (err) {
          logger.error('Personal email forward failed', { error: err });
        }
      });
    }

    // Schedule graph extraction (debounced 30s — Business/Enterprise only)
    if (hasFeature(orgTier, 'networkGraph')) {
      scheduleGraphExtraction(message.thread_id, finalOrgId);
    }

    // ─── Real-time push to frontend ──────────────────────────────
    const rtOrgId = inbox?.orgId || resolvedDomain?.orgId;
    if (rtOrgId) {
      const fromParticipant = message.participants?.find((p: any) => p.role === 'sender');
      realtimeService.emit(rtOrgId, {
        type: 'email.received',
        inbox_id: inbox?.id || null,
        inbox_address: inbox?.address || matchingRecipient || null,
        thread_id: message.thread_id,
        message_id: message.message_id,
        subject: message.metadata?.subject || '(no subject)',
        from: fromParticipant?.identity || fromEmail || null,
        direction: 'inbound',
        created_at: message.created_at,
      } as any);
    }

    if (inbox?.webhook?.endpoint) {
      const derivedDomainId = await domainStore.getDomainIdByInboxId(inbox.id);
      const outboundPayload = {
        domainId: derivedDomainId || resolvedDomainId,
        inboxId: inbox.id,
        inboxAddress: inbox.address || matchingRecipient,
        event,
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
          spam: {
            checked: true,
            score: spamAnalysis.spam_score,
            action: spamAnalysis.action,
            flagged: spamAnalysis.action === 'flag',
          },
          prompt_injection: {
            checked: true,
            detected: injectionAnalysis.detected,
            risk_level: injectionAnalysis.risk_level,
            confidence: injectionAnalysis.confidence,
            summary: injectionAnalysis.detected ? injectionAnalysis.summary : undefined,
            model_checked: injectionAnalysis.model_checked,
            model_provider: injectionAnalysis.model_provider,
            model_version: injectionAnalysis.model_version,
            model_score: injectionAnalysis.model_score,
            model_error: injectionAnalysis.model_error,
            model_tier: orgTier,
            model_allowed: allowLlmAdjudicator,
            fusion_score: injectionAnalysis.fusion_score,
            fusion_version: injectionAnalysis.fusion_version,
            reason_codes: injectionAnalysis.reason_codes,
            disagreement: injectionAnalysis.disagreement,
          },
        },
      };
      logger.info('Routing webhook via guaranteed delivery', {
        inboxId: inbox.id,
        endpoint: inbox.webhook.endpoint,
        messageId: (email as any).message_id,
      });

      // Guaranteed webhook delivery with retries, circuit breaker, and dead letter queue
      webhookDeliveryService.deliverWebhook({
        inbox_id: inbox.id,
        org_id: inbox.orgId,
        message_id: message.message_id,
        endpoint: inbox.webhook.endpoint,
        payload: outboundPayload,
        webhook_secret: inbox.webhook.secret,
      }).then(({ delivery_id, delivered }) => {
        if (delivered) {
          logger.info('Webhook delivered immediately', { delivery_id, inboxId: inbox.id });
        } else {
          logger.info('Webhook queued for retry', { delivery_id, inboxId: inbox.id });
        }
      }).catch((err) => {
        logger.error('Webhook delivery service error', {
          inboxId: inbox.id,
          endpoint: inbox.webhook?.endpoint,
          error: err,
        });
      });
    } else {
      logger.debug('No webhook configured for inbox', {
        inboxId: inbox?.id,
        localPart,
        domain: resolvedDomainName,
      });
    }
  } else {
    // Handle all other delivery events
    await handleDeliveryEvent(event, domainToUse);
  }

  return { data: { ok: true } };
};

export { handleInboundWebhook };
