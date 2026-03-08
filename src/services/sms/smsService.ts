import crypto from 'crypto';
import type { Request } from 'express';
import messageStore from '../../stores/messageStore';
import { phoneNumberStore } from '../../stores/phoneNumberStore';
import { creditStore, InsufficientCreditsError } from '../../stores/creditStore';
import { smsSuppressionStore } from '../../stores/smsSuppressionStore';
import {
  validateWebhookSignature,
  sendSms as twilioSendSms,
  isStopKeyword,
  isStartKeyword,
  fetchMmsMedia,
  subaccountClient,
} from './twilioService';
import { getCreditCost, getCountryFromE164 } from '../../config/smsCosts';
import { AttachmentStorageService } from '../attachmentStorageService';
import realtimeService from '../realtimeService';
import webhookDeliveryService from '../webhookDeliveryService';
import { getCollection } from '../../db';
import { decrypt } from '../../lib/encryption';
import {
  getCachedCreds,
  setCachedCreds,
  getCachedPhoneLookup,
  setCachedPhoneLookup,
} from '../../lib/smsCache';
import type { UnifiedMessage, TwilioInboundSmsPayload, TwilioStatusCallbackPayload } from '../../types';
import type { Organization } from '../../types/auth';
import { SmsProcessor } from './smsProcessor';
import logger from '../../utils/logger';

const WEBHOOK_BASE_URL = process.env.TWILIO_WEBHOOK_BASE_URL ?? 'https://api.commune.email';

// ─── Helpers ─────────────────────────────────────────────────────

function normalizeE164(phone: string): string {
  if (!phone.startsWith('+')) return phone;
  return '+' + phone.slice(1).replace(/\D/g, '');
}

function computeThreadId(orgId: string, phoneNumberId: string, remoteNumber: string): string {
  const key = `${orgId}:${phoneNumberId}:${normalizeE164(remoteNumber)}`;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
}

/**
 * Cache-aside: Redis (TTL 1h) → MongoDB + decrypt.
 * Saves ~10-50ms per SMS send/receive by avoiding repeated DB round-trips.
 */
async function getOrgSubaccountCredentials(orgId: string): Promise<{
  sid: string;
  authToken: string;
  messagingServiceSid: string;
} | null> {
  // 1. Redis cache hit
  const cached = await getCachedCreds(orgId);
  if (cached) return cached;

  // 2. MongoDB miss
  const orgs = await getCollection<Organization>('organizations');
  if (!orgs) return null;
  const org = await orgs.findOne(
    { id: orgId },
    { projection: { twilioSubaccountSid: 1, twilioSubaccountAuthToken: 1, twilioMessagingServiceSid: 1 } }
  );
  if (!org?.twilioSubaccountSid || !org?.twilioSubaccountAuthToken) return null;
  const authToken = decrypt(org.twilioSubaccountAuthToken as string);
  const creds = {
    sid: org.twilioSubaccountSid,
    authToken,
    messagingServiceSid: org.twilioMessagingServiceSid ?? '',
  };

  // 3. Populate cache (non-blocking)
  setCachedCreds(orgId, creds).catch(() => {});
  return creds;
}

/** Idempotency: insert MessageSid → returns true if it was a duplicate */
async function checkAndRecordDuplicate(messageSid: string): Promise<boolean> {
  const col = await getCollection<{ messageSid: string; processedAt: Date }>('sms_duplicates');
  if (!col) return false;
  try {
    await col.insertOne({ messageSid, processedAt: new Date() });
    return false;
  } catch {
    return true; // unique key violation = already processed
  }
}

/** Map Twilio delivery status to our internal delivery status */
function mapTwilioStatus(twilioStatus: string): 'sent' | 'delivered' | 'failed' | null {
  switch (twilioStatus) {
    case 'queued':
    case 'sending':
    case 'accepted':
      return null; // skip intermediate statuses
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'undelivered':
    case 'failed':
      return 'failed';
    default:
      return null;
  }
}

// ─── Send SMS ─────────────────────────────────────────────────────

export interface SendSmsPayload {
  to: string;              // E.164
  body: string;
  phone_number_id?: string;
  media_url?: string[];
  validity_period?: number;
}

export interface SendSmsResult {
  message_id: string;
  thread_id: string;
  message_sid: string;
  status: string;
  credits_charged: number;
  segments: number;
}

export async function sendSms(
  payload: SendSmsPayload,
  orgId: string
): Promise<SendSmsResult> {
  const { to, body, phone_number_id, media_url, validity_period } = payload;

  // Compute credit cost up-front (depends only on `to` and `media_url`, both available now)
  const country = getCountryFromE164(to);
  const messageType = media_url && media_url.length > 0 ? 'mms' : 'sms';
  const creditsNeeded = getCreditCost(country, 'outbound', messageType);

  // 1. Resolve phone number
  const phoneNumberPromise = phone_number_id
    ? phoneNumberStore.getPhoneNumber(phone_number_id, orgId)
    : phoneNumberStore.listPhoneNumbers(orgId).then(nums => nums.find(n => n.status === 'active') ?? null);

  // Run phone lookup, credit balance check, and subaccount creds in parallel —
  // all three are independent of each other.
  const [phoneNumber, balance, creds] = await Promise.all([
    phoneNumberPromise,
    creditStore.getBalance(orgId),
    getOrgSubaccountCredentials(orgId),
  ]);

  if (!phoneNumber) {
    throw Object.assign(new Error('No active phone number found'), { code: 'no_phone_number' });
  }
  if (phoneNumber.status !== 'active') {
    throw Object.assign(new Error(`Phone number is ${phoneNumber.status}`), { code: 'phone_number_not_active' });
  }
  if (!creds) {
    throw Object.assign(new Error('Twilio subaccount not provisioned'), { code: 'twilio_not_provisioned' });
  }

  const phoneNumberId = phoneNumber.id;

  // 2. Check suppression (needs phoneNumberId, runs after phone resolves)
  const suppressed = await smsSuppressionStore.isSuppressed(orgId, to, phoneNumberId);
  if (suppressed) {
    throw Object.assign(new Error('Recipient has opted out'), { code: 'recipient_suppressed' });
  }

  // 2b. Check allow/block list using already-fetched phoneNumber
  if (phoneNumber.blockList && phoneNumber.blockList.includes(to)) {
    throw Object.assign(
      new Error('Recipient is on the block list for this phone number'),
      { code: 'recipient_blocked' }
    );
  }
  if (phoneNumber.allowList && phoneNumber.allowList.length > 0 && !phoneNumber.allowList.includes(to)) {
    throw Object.assign(
      new Error('Recipient is not on the allow list for this phone number'),
      { code: 'recipient_not_allowed' }
    );
  }

  // 3. Credit check against already-fetched balance
  if (balance.total < creditsNeeded) {
    throw Object.assign(
      new InsufficientCreditsError(creditsNeeded, balance.total),
      { code: 'insufficient_phone_credits' }
    );
  }

  // 4. Compute thread_id
  const threadId = computeThreadId(orgId, phoneNumberId, to);

  // 5. Get subaccount client
  const client = subaccountClient(creds.sid, creds.authToken);

  // 6. Send via Twilio — deduction happens only on success
  const twilioResult = await twilioSendSms({
    client,
    messagingServiceSid: creds.messagingServiceSid || undefined,
    to,
    body,
    mediaUrl: media_url,
    validityPeriod: validity_period,
  });

  // 7. Deduct credits atomically
  try {
    await creditStore.deductCredits(orgId, creditsNeeded, `sms_outbound:${twilioResult.sid}`);
  } catch (err) {
    // Log but don't fail the send — message already sent; credits will be reconciled
    logger.error('Failed to deduct credits after successful SMS send', {
      orgId, sid: twilioResult.sid, credits: creditsNeeded, error: err,
    });
  }

  // 8. Build and store UnifiedMessage
  const messageId = `sms_${twilioResult.sid}`;
  const now = new Date().toISOString();
  const mappedStatus = mapTwilioStatus(twilioResult.status) ?? 'sent';

  const message: UnifiedMessage = {
    orgId,
    channel: 'sms',
    message_id: messageId,
    thread_id: threadId,
    direction: 'outbound',
    participants: [
      { role: 'sender', identity: phoneNumber.number },
      { role: 'to', identity: to },
    ],
    content: body,
    attachments: [],
    created_at: now,
    metadata: {
      created_at: now,
      subject: undefined,
      domain_id: null,
      inbox_id: phoneNumberId,
      delivery_status: mappedStatus,
      phone_number_id: phoneNumberId,
      from_number: phoneNumber.number,
      to_number: to,
      twilio_sid: twilioResult.sid,
      sms_segments: parseInt(twilioResult.numSegments, 10) || 1,
      credits_charged: creditsNeeded,
      num_media: media_url?.length ?? 0,
    },
  };

  try {
    await messageStore.insertMessage(message);
  } catch (err) {
    // DB insert failed — refund the credits
    logger.error('Failed to store SMS message, refunding credits', {
      orgId, messageId, error: err,
    });
    await creditStore.refundCredits(orgId, creditsNeeded).catch(() => {});
    throw err;
  }

  // 9. Index for vector search (fire-and-forget)
  SmsProcessor.getInstance().processMessage(message).catch(err => {
    logger.warn('SMS vector indexing failed (outbound)', { messageId, error: err });
  });

  // 10. Realtime event
  realtimeService.emit(orgId, {
    type: 'sms.sent',
    phone_number_id: phoneNumberId,
    to_number: to,
    thread_id: threadId,
    message_id: messageId,
    direction: 'outbound',
    created_at: now,
  });

  // 11. Webhook fanout (if phone number has webhook configured)
  if (phoneNumber.webhook?.endpoint) {
    webhookDeliveryService.deliverWebhook({
      inbox_id: phoneNumberId,
      org_id: orgId,
      message_id: messageId,
      endpoint: phoneNumber.webhook.endpoint,
      payload: {
        event: { type: 'sms.sent' },
        phone_number_id: phoneNumberId,
        from_number: phoneNumber.number,
        to_number: to,
        body,
        message_sid: twilioResult.sid,
        thread_id: threadId,
        message,
        num_segments: parseInt(twilioResult.numSegments, 10) || 1,
        num_media: media_url?.length ?? 0,
        credits_charged: creditsNeeded,
      },
      webhook_secret: phoneNumber.webhook.secret,
    }).catch(() => {});
  }

  return {
    message_id: messageId,
    thread_id: threadId,
    message_sid: twilioResult.sid,
    status: twilioResult.status,
    credits_charged: creditsNeeded,
    segments: parseInt(twilioResult.numSegments, 10) || 1,
  };
}

// ─── Handle Inbound SMS ────────────────────────────────────────

export interface InboundSmsResult {
  twiml: string;
  duplicate?: boolean;
  blocked?: boolean;
  suppressed?: boolean;
}

export async function handleInboundSms(req: Request): Promise<InboundSmsResult> {
  const body = req.body as TwilioInboundSmsPayload;
  const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

  // 1. Look up phone number by To field — try Redis cache first to avoid full collection scan
  const toNumber = normalizeE164(body.To ?? '');

  let phoneNumber: any = null;
  const cachedLookup = await getCachedPhoneLookup(toNumber);
  if (cachedLookup) {
    // Fetch full document (need allowList, blockList, autoReply, webhook)
    phoneNumber = await phoneNumberStore.getPhoneNumber(cachedLookup.phoneNumberId, cachedLookup.orgId);
  } else {
    const col = await getCollection('phone_numbers');
    if (col) {
      phoneNumber = await col.findOne({ number: toNumber }) as any;
      if (phoneNumber) {
        // Populate cache for future inbound messages
        setCachedPhoneLookup(toNumber, {
          phoneNumberId: phoneNumber.id,
          orgId: phoneNumber.orgId,
        }).catch(() => {});
      }
    }
  }

  if (!phoneNumber) {
    logger.warn('Inbound SMS to unknown number', { to: body.To });
    return { twiml: EMPTY_TWIML };
  }

  const orgId: string = phoneNumber.orgId;
  const phoneNumberId: string = phoneNumber.id;

  // 2. Validate Twilio webhook signature using subaccount auth token (cached)
  const creds = await getOrgSubaccountCredentials(orgId);
  if (!creds) {
    logger.error('No subaccount credentials for inbound SMS', { orgId });
    return { twiml: EMPTY_TWIML };
  }

  const signature = (req.headers['x-twilio-signature'] as string) ?? '';
  const webhookUrl = `${WEBHOOK_BASE_URL}/api/webhooks/twilio/inbound`;
  const valid = validateWebhookSignature(creds.authToken, signature, webhookUrl, body as unknown as Record<string, string>);
  if (!valid) {
    logger.warn('Invalid Twilio webhook signature for inbound SMS', { to: body.To });
    throw Object.assign(new Error('Invalid signature'), { code: 'invalid_signature', status: 403 });
  }

  // 3. Idempotency check
  const messageSid = body.MessageSid ?? '';
  const isDuplicate = await checkAndRecordDuplicate(messageSid);
  if (isDuplicate) {
    logger.debug('Duplicate inbound SMS skipped', { messageSid });
    return { twiml: EMPTY_TWIML, duplicate: true };
  }

  const fromNumber = normalizeE164(body.From ?? '');
  const numMedia = parseInt(body.NumMedia ?? '0', 10);

  // 4. Check allow/block list — inline using already-fetched phoneNumber (no extra DB call)
  const isAllowed = (() => {
    if ((phoneNumber.blockList || []).includes(fromNumber)) return false;
    if ((phoneNumber.allowList || []).length === 0) return true;
    return (phoneNumber.allowList || []).includes(fromNumber);
  })();

  if (!isAllowed) {
    logger.info('Inbound SMS blocked by allow/block list', { from: fromNumber, to: toNumber });
    const threadId = computeThreadId(orgId, phoneNumberId, fromNumber);
    const now = new Date().toISOString();
    const blockMessage: UnifiedMessage = {
      orgId,
      channel: 'sms',
      message_id: `sms_${messageSid}`,
      thread_id: threadId,
      direction: 'inbound',
      participants: [{ role: 'sender', identity: fromNumber }, { role: 'to', identity: toNumber }],
      content: body.Body ?? '',
      attachments: [],
      created_at: now,
      metadata: {
        created_at: now,
        domain_id: null,
        inbox_id: phoneNumberId,
        delivery_status: 'blocked',
        phone_number_id: phoneNumberId,
        from_number: fromNumber,
        to_number: toNumber,
        twilio_sid: messageSid,
        sms_segments: parseInt(body.NumSegments ?? '1', 10),
        credits_charged: 0,
        num_media: numMedia,
      },
    };
    await messageStore.insertMessage(blockMessage).catch(() => {});
    return { twiml: EMPTY_TWIML, blocked: true };
  }

  // 5. Check suppression — handle STOP/UNSTOP keywords first
  const messageBody = body.Body?.trim() ?? '';

  if (isStopKeyword(messageBody)) {
    await smsSuppressionStore.addSuppression(orgId, fromNumber, 'stop', undefined);
    logger.info('SMS STOP received — number suppressed', { from: fromNumber, orgId });
    // Fall through — still store the STOP message so agents see it
  } else if (isStartKeyword(messageBody)) {
    await smsSuppressionStore.removeSuppression(orgId, fromNumber);
    logger.info('SMS START received — suppression removed', { from: fromNumber, orgId });
  } else {
    const suppressed = await smsSuppressionStore.isSuppressed(orgId, fromNumber, phoneNumberId);
    if (suppressed) {
      logger.debug('Inbound SMS from suppressed number, discarding', { from: fromNumber });
      return { twiml: EMPTY_TWIML, suppressed: true };
    }
  }

  // 6. Compute thread_id
  const threadId = computeThreadId(orgId, phoneNumberId, fromNumber);
  const now = new Date().toISOString();

  // 7. Deduct inbound credits
  const inboundCountry = getCountryFromE164(fromNumber);
  const inboundCredits = getCreditCost(inboundCountry, 'inbound', numMedia > 0 ? 'mms' : 'sms');
  try {
    await creditStore.deductCredits(orgId, inboundCredits, `sms_inbound:${messageSid}`);
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      logger.warn('Insufficient credits for inbound SMS', { orgId, required: inboundCredits });
      // Store with credit_limit status but still process
    } else {
      logger.error('Credit deduction error for inbound SMS', { error: err });
    }
  }

  // 8. Handle MMS media — download all items in parallel
  const mmsMedia: Array<{ url: string; contentType: string; storageUrl?: string; attachmentId?: string }> = [];
  const attachmentIds: string[] = [];

  if (numMedia > 0) {
    const storageService = AttachmentStorageService.getInstance();

    const mediaResults = await Promise.all(
      Array.from({ length: numMedia }, async (_, i) => {
        const mediaUrl = (body as any)[`MediaUrl${i}`];
        const contentType = (body as any)[`MediaContentType${i}`] ?? 'application/octet-stream';
        if (!mediaUrl) return null;

        try {
          const { buffer, contentType: detectedType } = await fetchMmsMedia(
            mediaUrl,
            creds.sid,
            creds.authToken
          );
          const ext = (detectedType || contentType).split('/')[1]?.split(';')[0] ?? 'bin';
          const filename = `mms_${messageSid}_${i}.${ext}`;
          const uploadResult = await storageService.uploadAttachment(buffer, filename, detectedType || contentType, orgId);

          const attachmentId = crypto.randomUUID();
          await messageStore.insertAttachments([{
            attachment_id: attachmentId,
            message_id: `sms_${messageSid}`,
            filename,
            mime_type: detectedType || contentType,
            size: buffer.length,
            content_base64: uploadResult.content_base64 ?? null,
            source: 'sms',
            source_url: uploadResult.cloudinary_url ?? mediaUrl,
            storage_type: uploadResult.storage_type,
            cloudinary_url: uploadResult.cloudinary_url ?? null,
            cloudinary_public_id: uploadResult.cloudinary_public_id ?? null,
          }]);

          return {
            media: {
              url: mediaUrl,
              contentType: detectedType || contentType,
              storageUrl: uploadResult.cloudinary_url ?? undefined,
              attachmentId,
            },
            attachmentId,
          };
        } catch (err) {
          logger.error('Failed to fetch/store MMS media', { mediaUrl, error: err });
          return { media: { url: mediaUrl, contentType }, attachmentId: null };
        }
      })
    );

    for (const result of mediaResults) {
      if (!result) continue;
      mmsMedia.push(result.media);
      if (result.attachmentId) attachmentIds.push(result.attachmentId);
    }
  }

  // 9. Build and store UnifiedMessage
  const messageId = `sms_${messageSid}`;
  const message: UnifiedMessage = {
    orgId,
    channel: 'sms',
    message_id: messageId,
    thread_id: threadId,
    direction: 'inbound',
    participants: [
      { role: 'sender', identity: fromNumber },
      { role: 'to', identity: toNumber },
    ],
    content: body.Body ?? '',
    attachments: attachmentIds,
    created_at: now,
    metadata: {
      created_at: now,
      domain_id: null,
      inbox_id: phoneNumberId,
      delivery_status: 'delivered', // inbound = already delivered
      phone_number_id: phoneNumberId,
      from_number: fromNumber,
      to_number: toNumber,
      twilio_sid: messageSid,
      sms_segments: parseInt(body.NumSegments ?? '1', 10),
      credits_charged: inboundCredits,
      num_media: numMedia,
      mms_media: mmsMedia.length > 0 ? mmsMedia : undefined,
      has_attachments: attachmentIds.length > 0,
      attachment_count: attachmentIds.length,
    },
  };

  await messageStore.insertMessage(message);

  // 10. Index for vector search (fire-and-forget)
  SmsProcessor.getInstance().processMessage(message).catch(err => {
    logger.warn('SMS vector indexing failed (inbound)', { messageId, error: err });
  });

  // 11. Realtime event
  realtimeService.emit(orgId, {
    type: 'sms.received',
    phone_number_id: phoneNumberId,
    from_number: fromNumber,
    to_number: toNumber,
    thread_id: threadId,
    message_id: messageId,
    direction: 'inbound',
    created_at: now,
  });

  // 12. Webhook fanout
  if ((phoneNumber as any).webhook?.endpoint) {
    webhookDeliveryService.deliverWebhook({
      inbox_id: phoneNumberId,
      org_id: orgId,
      message_id: messageId,
      endpoint: (phoneNumber as any).webhook.endpoint,
      payload: {
        event: { type: 'sms.received' },
        phone_number_id: phoneNumberId,
        from_number: fromNumber,
        to_number: toNumber,
        body: body.Body ?? '',
        message_sid: messageSid,
        thread_id: threadId,
        message,
        num_segments: parseInt(body.NumSegments ?? '1', 10),
        num_media: numMedia,
        credits_charged: inboundCredits,
      },
      webhook_secret: (phoneNumber as any).webhook?.secret,
    }).catch(() => {});
  }

  // 13. Auto-reply — fire via setImmediate so TwiML is returned to Twilio before we begin
  if ((phoneNumber as any).autoReply?.enabled && (phoneNumber as any).autoReply?.body) {
    setImmediate(() => {
      sendSms(
        { to: fromNumber, body: (phoneNumber as any).autoReply.body, phone_number_id: phoneNumberId },
        orgId
      ).catch(err => {
        logger.warn('Auto-reply failed', { from: toNumber, to: fromNumber, error: err });
      });
    });
  }

  return { twiml: EMPTY_TWIML };
}

// ─── Handle Status Callback ───────────────────────────────────

export async function handleStatusCallback(req: Request): Promise<void> {
  const body = req.body as TwilioStatusCallbackPayload;

  // Look up phone number by From field (our number) to get subaccount credentials for sig validation
  const ourNumber = normalizeE164(body.From ?? '');
  const phoneNumberDoc = await (async () => {
    const col = await getCollection('phone_numbers');
    if (!col) return null;
    return col.findOne({ number: ourNumber }) as Promise<any>;
  })();

  // Validate signature if we have credentials; log but don't block on missing phone number
  if (phoneNumberDoc?.orgId) {
    const creds = await getOrgSubaccountCredentials(phoneNumberDoc.orgId);
    if (creds) {
      const signature = (req.headers['x-twilio-signature'] as string) ?? '';
      const webhookUrl = `${WEBHOOK_BASE_URL}/api/webhooks/twilio/status`;
      const valid = validateWebhookSignature(creds.authToken, signature, webhookUrl, body as unknown as Record<string, string>);
      if (!valid) {
        logger.warn('Invalid Twilio signature for status callback', { messageSid: body.MessageSid });
        throw Object.assign(new Error('Invalid signature'), { code: 'invalid_signature', status: 403 });
      }
    }
  }

  const messageSid = body.MessageSid;
  if (!messageSid) return;

  const newStatus = mapTwilioStatus(body.MessageStatus ?? '');
  if (!newStatus) return; // skip intermediate statuses (queued, sending, accepted)

  const messageId = `sms_${messageSid}`;
  const now = new Date().toISOString();
  const deliveryData: Record<string, string> = { updated_at: now };

  if (newStatus === 'sent') deliveryData.sent_at = now;
  else if (newStatus === 'delivered') deliveryData.delivered_at = now;
  else if (newStatus === 'failed') {
    deliveryData.failed_at = now;
    if (body.ErrorCode) deliveryData.error_code = body.ErrorCode;
    if (body.ErrorMessage) deliveryData.error_message = body.ErrorMessage;
  }

  await messageStore.updateDeliveryStatus(messageId, newStatus, deliveryData);

  // Emit realtime update
  if (phoneNumberDoc?.orgId) {
    realtimeService.emit(phoneNumberDoc.orgId, {
      type: 'sms.status_updated',
      message_id: messageId,
      phone_number_id: phoneNumberDoc.id,
    });
  }
}
