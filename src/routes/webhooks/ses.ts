/**
 * SES delivery events webhook.
 *
 * SNS posts notifications here for all SES events configured in the
 * commune-sending Configuration Set (SEND, DELIVERY, BOUNCE, COMPLAINT,
 * OPEN, CLICK, REJECT, DELIVERY_DELAY, SUBSCRIPTION).
 *
 * Also handles SNS SubscriptionConfirmation on first setup.
 */

import { Router, json } from 'express';
import { verifySnsMessage } from '../../lib/verifySns';
import messageStore from '../../stores/messageStore';
import suppressionStore from '../../stores/suppressionStore';
import deliveryEventStore from '../../stores/deliveryEventStore';
import securityStore from '../../stores/securityStore';
import SendingHealthService from '../../services/sendingHealthService';
import metricsCacheService from '../../services/metricsCacheService';
import { buildOrphanEventData } from '../../services/deliveryEventUtils';
import logger from '../../utils/logger';

const router = Router();

// SNS sends Content-Type: text/plain for its JSON payloads
router.use(json({ type: ['application/json', 'text/plain'] }));

// ─── Map SES eventType → internal DeliveryEvent type ───────────────────────

const SES_EVENT_MAP: Record<string, string> = {
  Send: 'sent',
  Delivery: 'delivered',
  Bounce: 'bounced',
  Complaint: 'complained',
  Reject: 'failed',
  Open: 'opened',
  Click: 'clicked',
  DeliveryDelay: 'delivery_delayed',
  Subscription: 'suppressed',
};

const mapSesEventType = (eventType: string): string | null => SES_EVENT_MAP[eventType] || null;

// ─── Extract tag value (SES tags are arrays: { orgId: ["xxx"] }) ────────────

const getTag = (tags: Record<string, string[]> | undefined, key: string): string | undefined =>
  tags?.[key]?.[0];

// ─── Main handler ────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid body' });
  }

  // SNS signature verification
  try {
    await verifySnsMessage(body);
  } catch (err) {
    logger.warn('SNS signature verification failed', { error: err });
    return res.status(400).json({ error: 'Invalid SNS signature' });
  }

  // Handle SubscriptionConfirmation — auto-confirm by fetching the SubscribeURL
  if (body.Type === 'SubscriptionConfirmation') {
    const subscribeUrl = body.SubscribeURL as string;
    logger.info('SNS SubscriptionConfirmation received', { subscribeUrl });
    try {
      await fetch(subscribeUrl);
      logger.info('SNS subscription confirmed');
    } catch (err) {
      logger.error('SNS subscription confirmation failed', { error: err });
    }
    return res.status(200).json({ ok: true });
  }

  // Handle Notification
  if (body.Type !== 'Notification') {
    return res.status(200).json({ ok: true }); // ignore UnsubscribeConfirmation etc.
  }

  let event: Record<string, any>;
  try {
    event = JSON.parse(body.Message as string);
  } catch {
    logger.warn('Failed to parse SNS Message');
    return res.status(400).json({ error: 'Malformed SNS Message' });
  }

  const sesEventType = event.eventType as string;
  const mail = event.mail as Record<string, any>;
  const tags = mail?.tags as Record<string, string[]> | undefined;

  // Extract identifiers from EmailTags (orgId + inboxId stamped at send time)
  const orgId = getTag(tags, 'orgId');
  const inboxId = getTag(tags, 'inboxId') !== 'none' ? getTag(tags, 'inboxId') : undefined;
  const sesMessageId = mail?.messageId as string | undefined;

  if (!sesMessageId) {
    logger.debug('SES event missing mail.messageId', { sesEventType });
    return res.status(200).json({ ok: true });
  }

  logger.debug('SES event received', { sesEventType, sesMessageId, orgId, inboxId });

  const mappedType = mapSesEventType(sesEventType);
  if (!mappedType) {
    logger.debug('Unhandled SES event type', { sesEventType });
    return res.status(200).json({ ok: true });
  }

  try {
    await handleSesEvent({ event, sesEventType, mappedType, sesMessageId, orgId, inboxId });
  } catch (err) {
    logger.error('SES event handling error', { sesEventType, sesMessageId, error: err });
  }

  return res.status(200).json({ ok: true });
});

// ─── Event Processing ─────────────────────────────────────────────────────────

const handleSesEvent = async ({
  event,
  sesEventType,
  mappedType,
  sesMessageId,
  orgId,
  inboxId,
}: {
  event: Record<string, any>;
  sesEventType: string;
  mappedType: string;
  sesMessageId: string;
  orgId?: string;
  inboxId?: string;
}) => {
  const message = await messageStore.getMessageByResendId(sesMessageId);
  const eventCreatedAt = event.mail?.timestamp || new Date().toISOString();
  const resolvedInboxId = message?.metadata?.inbox_id || inboxId;
  const resolvedDomainId = message?.metadata?.domain_id || undefined;
  const messageId = message?.message_id || sesMessageId;

  if (!message) {
    // Orphan event — store for debugging
    await deliveryEventStore.storeEvent({
      message_id: sesMessageId,
      event_type: mappedType as any,
      event_data: buildOrphanEventData({ raw: event }, sesMessageId, 'message_not_found'),
      inbox_id: resolvedInboxId,
      domain_id: resolvedDomainId,
    });
    logger.debug('Stored orphan SES delivery event', { sesEventType, sesMessageId });
    return;
  }

  switch (sesEventType) {
    case 'Send':
      await messageStore.updateDeliveryStatus(messageId, 'sent', { sent_at: eventCreatedAt }, resolvedInboxId);
      await deliveryEventStore.storeEvent({ message_id: messageId, event_type: 'sent', event_data: event, inbox_id: resolvedInboxId, domain_id: resolvedDomainId });
      break;

    case 'Delivery': {
      await messageStore.updateDeliveryStatus(messageId, 'delivered', { delivered_at: eventCreatedAt }, resolvedInboxId);
      await deliveryEventStore.storeEvent({ message_id: messageId, event_type: 'delivered', event_data: event, inbox_id: resolvedInboxId, domain_id: resolvedDomainId });
      const recipient = event.delivery?.recipients?.[0] || '';
      if (recipient) await securityStore.resetSoftBounce(recipient);
      break;
    }

    case 'Bounce': {
      const bounceType = event.bounce?.bounceType === 'Permanent' ? 'hard' : 'soft';
      const bounceSubType = event.bounce?.bounceSubType || '';
      const bouncedRecipient = event.bounce?.bouncedRecipients?.[0] || {};
      const recipient = bouncedRecipient.emailAddress || '';
      const bounceReason = bouncedRecipient.diagnosticCode || bounceSubType || 'Unknown';
      const bounceDiagnostic = bouncedRecipient.diagnosticCode || null;

      await messageStore.updateDeliveryStatus(messageId, 'bounced', {
        bounced_at: eventCreatedAt,
        bounce_reason: bounceReason,
        bounce_type: bounceType,
        bounce_diagnostic: bounceDiagnostic,
        bounce_sub_type: bounceSubType,
      }, resolvedInboxId);

      if (bounceType === 'hard') {
        await suppressionStore.addSuppression({
          email: recipient, reason: 'bounce', type: 'hard', source: 'inbox',
          inbox_id: resolvedInboxId, domain_id: resolvedDomainId, message_id: messageId,
          metadata: { bounce_reason: bounceReason, bounce_diagnostic: bounceDiagnostic, original_subject: message.metadata?.subject },
        });
      } else {
        const SOFT_BOUNCE_THRESHOLD = Number(process.env.SOFT_BOUNCE_THRESHOLD || 3);
        const SOFT_BOUNCE_SUPPRESSION_DAYS = Number(process.env.SOFT_BOUNCE_SUPPRESSION_DAYS || 7);
        const softBounceCount = await securityStore.incrementSoftBounce({ email: recipient, reason: bounceReason, inboxId: resolvedInboxId });
        if (softBounceCount >= SOFT_BOUNCE_THRESHOLD) {
          const expiresAt = new Date(Date.now() + SOFT_BOUNCE_SUPPRESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
          await suppressionStore.addSuppression({
            email: recipient, reason: 'bounce', type: 'soft', source: 'inbox',
            inbox_id: resolvedInboxId, domain_id: resolvedDomainId, message_id: messageId,
            expires_at: expiresAt, metadata: { bounce_reason: bounceReason, soft_bounce_count: softBounceCount },
          });
        }
      }

      if (orgId) SendingHealthService.getInstance().recordBounce(orgId).catch(() => {});
      await deliveryEventStore.storeEvent({ message_id: messageId, event_type: 'bounced', event_data: event, inbox_id: resolvedInboxId, domain_id: resolvedDomainId });
      break;
    }

    case 'Complaint': {
      const recipient = event.complaint?.complainedRecipients?.[0]?.emailAddress || '';
      const complaintType = event.complaint?.complaintFeedbackType || null;

      await messageStore.updateDeliveryStatus(messageId, 'complained', { complained_at: eventCreatedAt }, resolvedInboxId);
      await suppressionStore.addSuppression({
        email: recipient, reason: 'complaint', type: 'spam', source: 'inbox',
        inbox_id: resolvedInboxId, domain_id: resolvedDomainId, message_id: messageId,
        metadata: { complaint_type: complaintType || undefined, original_subject: message.metadata?.subject },
      });
      if (orgId) SendingHealthService.getInstance().recordComplaint(orgId).catch(() => {});
      await deliveryEventStore.storeEvent({ message_id: messageId, event_type: 'complained', event_data: event, inbox_id: resolvedInboxId, domain_id: resolvedDomainId });
      break;
    }

    case 'Open': {
      // OPEN tracking — new in SES, not available in Resend
      const openTimestamp = event.open?.timestamp || eventCreatedAt;
      const userAgent = event.open?.userAgent || null;
      const ipAddress = event.open?.ipAddress || null;

      await messageStore.updateDeliveryStatus(messageId, 'opened', { opened_at: openTimestamp }, resolvedInboxId);
      await deliveryEventStore.storeEvent({
        message_id: messageId,
        event_type: 'opened' as any,
        event_data: { ...event, _meta: { user_agent: userAgent, ip_address: ipAddress, timestamp: openTimestamp } },
        inbox_id: resolvedInboxId,
        domain_id: resolvedDomainId,
      });
      logger.debug('Open event recorded', { messageId, userAgent });
      break;
    }

    case 'Click': {
      // CLICK tracking — new in SES, not available in Resend
      const clickTimestamp = event.click?.timestamp || eventCreatedAt;
      const link = event.click?.link || null;
      const userAgent = event.click?.userAgent || null;

      await deliveryEventStore.storeEvent({
        message_id: messageId,
        event_type: 'clicked' as any,
        event_data: { ...event, _meta: { link, user_agent: userAgent, timestamp: clickTimestamp } },
        inbox_id: resolvedInboxId,
        domain_id: resolvedDomainId,
      });
      logger.debug('Click event recorded', { messageId, link });
      break;
    }

    case 'Reject':
      await messageStore.updateDeliveryStatus(messageId, 'failed', { failed_at: eventCreatedAt, failure_reason: event.reject?.reason || 'Rejected' }, resolvedInboxId);
      await deliveryEventStore.storeEvent({ message_id: messageId, event_type: 'failed', event_data: event, inbox_id: resolvedInboxId, domain_id: resolvedDomainId });
      break;

    case 'DeliveryDelay':
      await deliveryEventStore.storeEvent({ message_id: messageId, event_type: 'delivery_delayed', event_data: event, inbox_id: resolvedInboxId, domain_id: resolvedDomainId });
      break;

    case 'Subscription':
      await messageStore.updateDeliveryStatus(messageId, 'suppressed', { suppressed_at: eventCreatedAt, suppression_reason: 'subscription' }, resolvedInboxId);
      await deliveryEventStore.storeEvent({ message_id: messageId, event_type: 'suppressed', event_data: event, inbox_id: resolvedInboxId, domain_id: resolvedDomainId });
      break;

    default:
      logger.debug('Unhandled SES event', { sesEventType });
  }

  if (resolvedInboxId) {
    metricsCacheService.clearInboxCache(resolvedInboxId);
  }
};

export default router;
