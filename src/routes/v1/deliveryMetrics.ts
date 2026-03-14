import { Router, json } from 'express';
import { requirePermission } from '../../middleware/permissions';
import messageStore from '../../stores/messageStore';
import deliveryEventStore from '../../stores/deliveryEventStore';
import suppressionStore from '../../stores/suppressionStore';
import domainStore from '../../stores/domainStore';
import logger from '../../utils/logger';

const router = Router();

/**
 * GET /v1/delivery/metrics
 * Get delivery metrics for an inbox over a time period.
 * Query: inbox_id (required), days (optional, default 7)
 */
router.get('/metrics', json(), requirePermission('messages:read'), async (req: any, res) => {
  const orgId = req.orgId;
  const inboxId = (req.query.inbox_id || req.query.inboxId) as string | undefined;
  const domainId = (req.query.domain_id || req.query.domainId) as string | undefined;

  // Accept both "days=7" and "period=7d/24h/30d" formats
  let days = 7;
  const period = req.query.period as string;
  if (period) {
    const match = period.match(/^(\d+)(d|h)$/);
    if (match) {
      days = match[2] === 'h' ? Math.max(1, Math.ceil(parseInt(match[1]) / 24)) : parseInt(match[1]);
    }
  } else if (req.query.days) {
    days = parseInt(req.query.days as string) || 7;
  }
  days = Math.min(days, 90);

  if (!inboxId && !domainId) {
    return res.status(400).json({ error: 'inbox_id or domain_id query parameter is required' });
  }

  try {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const metrics = await messageStore.getInboxDeliveryMetrics(inboxId, startDate, endDate, domainId);

    res.set('Cache-Control', 'private, max-age=10, stale-while-revalidate=20');
    return res.json({
      data: {
        inbox_id: inboxId || undefined,
        domain_id: domainId || undefined,
        period: { start: startDate.toISOString(), end: endDate.toISOString(), days },
        ...metrics,
        delivery_rate: metrics.sent > 0
          ? ((metrics.delivered / metrics.sent) * 100).toFixed(1) + '%'
          : 'N/A',
        bounce_rate: metrics.sent > 0
          ? ((metrics.bounced / metrics.sent) * 100).toFixed(1) + '%'
          : 'N/A',
        complaint_rate: metrics.sent > 0
          ? ((metrics.complained / metrics.sent) * 100).toFixed(1) + '%'
          : 'N/A',
        failure_rate: metrics.sent > 0
          ? ((metrics.failed / metrics.sent) * 100).toFixed(1) + '%'
          : 'N/A',
        suppression_rate: metrics.sent > 0
          ? ((metrics.suppressed / metrics.sent) * 100).toFixed(1) + '%'
          : 'N/A',
        orphan_event_rate: metrics.sent > 0
          ? ((metrics.orphan_events / metrics.sent) * 100).toFixed(1) + '%'
          : 'N/A',
      },
    });
  } catch (err) {
    logger.error('v1: Failed to get delivery metrics', { orgId, inboxId, error: err });
    return res.status(500).json({ error: 'Failed to get delivery metrics' });
  }
});

/**
 * GET /v1/delivery/events
 * List recent delivery events for an inbox.
 * Query: inbox_id (required), event_type (optional), limit (optional, default 50)
 */
router.get('/events', json(), requirePermission('messages:read'), async (req: any, res) => {
  const inboxId = (req.query.inbox_id || req.query.inboxId) as string | undefined;
  const domainId = (req.query.domain_id || req.query.domainId) as string | undefined;
  const messageId = (req.query.message_id || req.query.messageId) as string | undefined;
  const eventType = (req.query.event_type || req.query.eventType) as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

  if (!inboxId && !domainId && !messageId) {
    return res.status(400).json({ error: 'Provide at least one of: inbox_id, domain_id, message_id' });
  }

  try {
    const events = await deliveryEventStore.getEvents({
      inboxId,
      domainId,
      messageId,
      eventType,
      limit,
    });
    res.set('Cache-Control', 'private, max-age=5, stale-while-revalidate=15');
    return res.json({ data: events });
  } catch (err) {
    logger.error('v1: Failed to get delivery events', { inboxId, domainId, messageId, error: err });
    return res.status(500).json({ error: 'Failed to get delivery events' });
  }
});

/**
 * GET /v1/delivery/suppressions
 * List suppressed email addresses for an inbox.
 * Query: inbox_id (required)
 */
router.get('/suppressions', json(), requirePermission('messages:read'), async (req: any, res) => {
  const orgId = req.orgId;
  const inboxId = (req.query.inbox_id || req.query.inboxId) as string | undefined;
  const domainId = (req.query.domain_id || req.query.domainId) as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

  if (!inboxId && !domainId) {
    return res.status(400).json({ error: 'inbox_id or domain_id query parameter is required' });
  }

  try {
    let suppressions;
    if (inboxId) {
      suppressions = await suppressionStore.getSuppressions({ inboxId, limit });
    } else {
      const inboxes = await domainStore.listInboxes(domainId!, orgId);
      suppressions = await suppressionStore.getSuppressions({
        domainId,
        inboxIds: inboxes.map((i: any) => i.id),
        limit,
      });
    }
    res.set('Cache-Control', 'private, max-age=30, stale-while-revalidate=60');
    return res.json({ data: suppressions });
  } catch (err) {
    logger.error('v1: Failed to get suppressions', { orgId, inboxId, domainId, error: err });
    return res.status(500).json({ error: 'Failed to get suppressions' });
  }
});

export default router;
