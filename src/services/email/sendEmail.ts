import resend from '../resendClient';
import messageStore from '../../stores/messageStore';
import suppressionStore from '../../stores/suppressionStore';
import deliveryEventStore from '../../stores/deliveryEventStore';
import domainStore from '../../stores/domainStore';
import type { SendMessagePayload } from '../../types';
import crypto from 'crypto';
import { EmailProcessor } from '../emailProcessor';
import EmailValidationService from '../emailValidationService';
import SendingHealthService from '../sendingHealthService';
import DomainWarmupService from '../domainWarmupService';
import { buildUnsubscribeUrl } from '../../lib/unsubscribeToken';
import { sanitizeCustomHeaders } from '../../lib/sanitize';
import { encodeThreadToken } from '../../lib/threadToken';
import { extractEmailAddress, normalizeRecipient } from './helpers';
import { scheduleGraphExtraction } from '../graphExtractionService';
import { resolveOrgTier } from '../../lib/tierResolver';
import { hasFeature } from '../../config/rateLimits';
import logger from '../../utils/logger';

const DEFAULT_FROM_EMAIL = process.env.DEFAULT_FROM_EMAIL;
const DEFAULT_FROM_LOCAL_PART = process.env.DEFAULT_FROM_LOCAL_PART || 'agent';

/**
 * Format a From address with an optional display name.
 * e.g. "Support Agent" <support@example.com>
 * Resend and most SMTP servers accept RFC 5322 display name format.
 */
const formatFromWithDisplayName = (email: string, displayName?: string | null): string => {
  if (!displayName) return email;
  // Escape quotes in display name
  const safe = displayName.replace(/"/g, '\\"');
  return `"${safe}" <${email}>`;
};

const buildFromAddress = async ({
  from,
  domainId,
  inboxId,
  domain,
  localPart,
}: {
  from?: string;
  domainId?: string;
  inboxId?: string;
  domain?: string;
  localPart?: string;
}): Promise<{ address: string | null; resolvedDomainId?: string }> => {
  if (from) {
    // If inboxId is also provided, look up the inbox's displayName
    // so the From header includes it (e.g. "Support Bot" <support@example.com>)
    if (inboxId) {
      let resolvedDomainId = domainId;
      if (!resolvedDomainId) {
        resolvedDomainId = await domainStore.getDomainIdByInboxId(inboxId) || undefined;
      }
      if (resolvedDomainId) {
        const inbox = await domainStore.getInbox(resolvedDomainId, inboxId);
        const displayName = inbox?.displayName || inbox?.agent?.name || null;
        if (displayName) {
          // Strip any existing display name from `from` to avoid double-wrapping
          const rawEmail = extractEmailAddress(from) || from;
          return { address: formatFromWithDisplayName(rawEmail, displayName), resolvedDomainId };
        }
      }
    }
    return { address: from };
  }

  const resolvedLocal = localPart || DEFAULT_FROM_LOCAL_PART;

  // If inboxId is provided without domainId, resolve domainId from the inbox
  let effectiveDomainId = domainId;
  if (inboxId && !effectiveDomainId) {
    effectiveDomainId = await domainStore.getDomainIdByInboxId(inboxId) || undefined;
  }

  if (effectiveDomainId) {
    if (inboxId) {
      const inbox = await domainStore.getInbox(effectiveDomainId, inboxId);
      const displayName = inbox?.displayName || inbox?.agent?.name || null;
      if (inbox?.localPart) {
        const entry = await domainStore.getDomain(effectiveDomainId);
        if (entry?.name) {
          // Prefer current domain name over persisted inbox.address so
          // shared-domain renames take effect immediately.
          const rawAddr = `${inbox.localPart}@${entry.name}`;
          return { address: formatFromWithDisplayName(rawAddr, displayName), resolvedDomainId: effectiveDomainId };
        }
      }
      if (inbox?.address) {
        return { address: formatFromWithDisplayName(inbox.address, displayName), resolvedDomainId: effectiveDomainId };
      }
    }

    const entry = await domainStore.getDomain(effectiveDomainId);
    if (entry && entry.name) {
      return { address: `${resolvedLocal}@${entry.name}`, resolvedDomainId: effectiveDomainId };
    }
    if (domain) {
      return { address: `${resolvedLocal}@${domain}`, resolvedDomainId: effectiveDomainId };
    }
  }

  if (domain) {
    return { address: `${resolvedLocal}@${domain}` };
  }

  return { address: DEFAULT_FROM_EMAIL || null };
};

const sendEmail = async (payload: SendMessagePayload & { orgId?: string }) => {
  const fromResult = await buildFromAddress({
    from: payload.from,
    domainId: payload.domainId,
    inboxId: payload.inboxId,
    domain: payload.domain,
    localPart: payload.localPart,
  });
  const fromAddress = fromResult.address;
  if (!fromAddress) {
    return { error: { message: 'Missing from address' } };
  }
  // Use resolved domainId if caller didn't provide one (inboxId-only send)
  if (fromResult.resolvedDomainId && !payload.domainId) {
    payload.domainId = fromResult.resolvedDomainId;
  }

  const existingMessageIdHeader =
    payload.headers?.['Message-ID'] ||
    payload.headers?.['message-id'] ||
    payload.headers?.['Message-Id'];
  const fallbackDomain =
    extractEmailAddress(fromAddress)?.split('@')[1] ||
    extractEmailAddress(payload.from)?.split('@')[1] ||
    payload.domain ||
    DEFAULT_FROM_EMAIL?.split('@')[1] ||
    'commune.local';
  const outboundMessageId =
    existingMessageIdHeader || `<${crypto.randomUUID()}@${fallbackDomain}>`;
  const generatedThreadId = `thread_${crypto.randomUUID()}`;

  // Check suppressions before sending
  const recipients = Array.isArray(payload.to) ? payload.to : [payload.to];
  const unsuppressedRecipients: string[] = [];
  const suppressedRecipients: string[] = [];

  for (const recipient of recipients) {
    const isSuppressed = await suppressionStore.isSuppressed(recipient, payload.inboxId);

    if (!isSuppressed) {
      unsuppressedRecipients.push(recipient);
    } else {
      suppressedRecipients.push(recipient);
      logger.debug('Skipping suppressed recipient', { recipient });
    }
  }

  if (unsuppressedRecipients.length === 0) {
    return { error: { message: 'All recipients are suppressed' } };
  }

  // Validate recipients (syntax + MX lookup + disposable/role warnings)
  const validationService = EmailValidationService.getInstance();
  const validation = await validationService.validateRecipients(unsuppressedRecipients);
  if (suppressedRecipients.length > 0) {
    validation.suppressed = suppressedRecipients;
  }

  if (validation.rejected.length > 0) {
    logger.info('Recipient validation rejected', { rejected: validation.rejected });
  }
  if (validation.warnings.length > 0) {
    logger.debug('Recipient validation warnings', { warnings: validation.warnings });
  }

  const validRecipients = validation.valid;
  if (validRecipients.length === 0) {
    return {
      error: {
        message: 'All recipients are invalid',
        validation,
      },
    };
  }

  let headers = payload.headers ? sanitizeCustomHeaders(payload.headers) : {};
  let subject = payload.subject || '';

  // Ensure a stable Message-ID for this outbound email so replies can thread correctly.
  if (!headers['Message-ID'] && !headers['message-id'] && !headers['Message-Id']) {
    headers = { ...headers, 'Message-ID': outboundMessageId };
  } else {
    headers = { ...headers, 'Message-ID': outboundMessageId };
  }

  // Always stamp Reply-To with an opaque routing token so inbound replies
  // can be mapped back to the correct thread — even if providers rewrite
  // the Message-ID or References headers. Skip only if user explicitly set reply_to.
  const hasReplyTo = !!(payload.replyTo || payload.reply_to);
  let replyToAddress = payload.replyTo || payload.reply_to;
  let routingToken: string | null = null;
  if (!hasReplyTo) {
    const effectiveThreadId = payload.thread_id || generatedThreadId;
    routingToken = encodeThreadToken(effectiveThreadId);
    const fromRecipient = normalizeRecipient(fromAddress);
    if (fromRecipient?.localPartBase && fromRecipient?.domain) {
      replyToAddress = `${fromRecipient.localPartBase}+${routingToken}@${fromRecipient.domain}`;
    }
  }

  if (payload.thread_id) {
    const latest = await messageStore.getLatestMessageInThread(
      payload.thread_id,
      payload.orgId
    );
    if (latest && latest.metadata) {
      // RFC 5322: In-Reply-To must reference the Message-ID that the recipient
      // actually received — which is the Resend-format ID, not our custom one.
      // For old messages, fall back to whatever message_id we stored.
      const replyToMsgId = latest.metadata.resend_id
        ? `<${latest.metadata.resend_id}@resend.dev>`
        : latest.metadata.message_id;
      if (replyToMsgId) {
        // Build References chain from existing references + latest message_id
        const existingRefs = latest.metadata.references || [];
        const refsChain = [...existingRefs, replyToMsgId].filter(Boolean);
        headers = {
          ...headers,
          'In-Reply-To': replyToMsgId,
          References: refsChain.join(' '),
        };
      }
    }
    if (subject && !subject.startsWith('Re:')) {
      subject = `Re: ${subject}`;
    }
  }

  // Process attachments - fetch from database and convert to Resend format
  let resendAttachments: any[] = [];
  if (payload.attachments && Array.isArray(payload.attachments) && payload.attachments.length > 0) {
    for (const attachmentId of payload.attachments) {
      try {
        const attachment = await messageStore.getAttachment(attachmentId);
        if (attachment) {
          // Use Cloudinary URL if available, otherwise use base64 content
          if (attachment.storage_type === 'cloudinary' && attachment.cloudinary_url) {
            resendAttachments.push({
              path: attachment.cloudinary_url,
              filename: attachment.filename,
            });
          } else if (attachment.content_base64) {
            resendAttachments.push({
              content: attachment.content_base64,
              filename: attachment.filename,
            });
          }
        }
      } catch (err) {
        logger.error('Failed to fetch attachment', { attachmentId, error: err });
      }
    }
  }

  // Update payload with valid recipients only
  // Add List-Unsubscribe headers for Gmail/Yahoo deliverability compliance (RFC 8058)
  if (payload.orgId && validRecipients.length > 0) {
    const unsubscribeUrl = buildUnsubscribeUrl({
      orgId: payload.orgId,
      recipient: validRecipients[0],
      inboxId: payload.inboxId,
    });
    if (unsubscribeUrl) {
      headers = {
        ...headers,
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      };
    }
  }

  const emailPayload = {
    from: fromAddress,
    to: validRecipients.length === recipients.length ? payload.to : validRecipients,
    subject,
    html: payload.html,
    text: payload.text,
    cc: payload.cc,
    bcc: payload.bcc,
    headers,
    attachments: resendAttachments.length > 0 ? resendAttachments : undefined,
    reply_to: replyToAddress,
  } as any;

  const { data, error } = await resend.emails.send(emailPayload);

  if (error) {
    return { error };
  }

  // Record successful send for circuit breaker health tracking
  if (payload.orgId) {
    SendingHealthService.getInstance().recordSend(payload.orgId).catch(() => {});
  }
  // Record domain send for warmup tracking
  if (payload.domainId) {
    DomainWarmupService.getInstance().recordDomainSend(payload.domainId).catch(() => {});
  }

  const threadId = payload.thread_id || generatedThreadId;
  const createdAt = new Date().toISOString();

  // Build the Resend-format Message-ID that recipients actually see in their email client.
  // When a recipient replies, their client puts THIS ID in In-Reply-To — not our custom one.
  // Resend uses the format: <resend-api-id@resend.dev>
  const resendId = (data as any).id;
  const resendMessageId = `<${resendId}@resend.dev>`;

  const sentMessage = {
    orgId: payload.orgId,
    channel: 'email' as const,
    message_id: resendId,
    thread_id: threadId,
    direction: 'outbound' as const,
    participants: [
      { role: 'sender' as const, identity: fromAddress },
      ...(Array.isArray(payload.to)
        ? payload.to.map((addr) => ({ role: 'to' as const, identity: addr }))
        : [{ role: 'to' as const, identity: payload.to }]),
    ],
    content: payload.text || '',
    content_html: payload.html || null,
    attachments: payload.attachments || [],
    created_at: createdAt,
    metadata: {
      created_at: createdAt,
      subject,
      // RFC 5322 threading: store ALL Message-ID variants so inbound replies can match.
      // - message_id: the Resend-format ID that recipients actually see (<id@resend.dev>)
      // - custom_message_id: our custom ID (<uuid@domain>) for internal reference
      // - resend_id: the plain Resend API response ID (no angle brackets)
      // - commune_message_id: pre-generated stable ID returned in 202 responses
      message_id: resendMessageId,
      custom_message_id: outboundMessageId,
      resend_id: resendId,
      commune_message_id: payload._messageId || null,
      in_reply_to: headers['In-Reply-To'] || null,
      references: headers.References ? String(headers.References).split(' ') : [],
      domain_id: payload.domainId || null,
      inbox_id: payload.inboxId || null,
      attachment_ids: payload.attachments || [],
      has_attachments: (payload.attachments || []).length > 0,
      attachment_count: (payload.attachments || []).length,
      routing_token: routingToken || null,
    },
  };

  await messageStore.insertMessage(sentMessage);

  // Index sent email for vector search — fire-and-forget (Qdrant does not need to
  // complete before returning the API response; saves 50-200ms per send)
  EmailProcessor.getInstance().processMessage(sentMessage).catch(err =>
    logger.error('Vector indexing failed (outbound)', { messageId: sentMessage.message_id, error: err })
  );

  // Schedule graph extraction (debounced 30s — Business/Enterprise only)
  const sendTier = await resolveOrgTier(sentMessage.orgId);
  if (hasFeature(sendTier, 'networkGraph')) {
    scheduleGraphExtraction(sentMessage.thread_id, sentMessage.orgId);
  }

  // Note: We don't store a 'sent' delivery event here because Resend's email.sent
  // webhook will fire shortly and the webhook handler will record it. Storing it
  // here would create a duplicate event that inflates the sent count.

  return {
    data: { ...(data as any), thread_id: threadId, smtp_message_id: resendMessageId },
    validation,
  };
};

export { sendEmail };
