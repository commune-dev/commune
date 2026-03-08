import { Router } from 'express';
import { getSubClient } from '../../lib/redis';
import logger from '../../utils/logger';

const router = Router();

const SMS_EVENT_TYPES = new Set(['sms.received', 'sms.sent', 'sms.status_updated']);
const EMAIL_EVENT_TYPES = new Set(['email.received', 'email.sent']);
const ALL_ALLOWED = new Set([...SMS_EVENT_TYPES, ...EMAIL_EVENT_TYPES]);

// ─── GET /v1/events/stream ────────────────────────────────────────
// SSE endpoint for CLI real-time event listening (API key auth)
router.get('/stream', async (req: any, res) => {
  const orgId: string = req.orgId;

  // Parse filters
  const phoneNumberId = req.query.phone_number_id as string | undefined;
  const inboxId = req.query.inbox_id as string | undefined;
  const rawEvents = req.query.events as string | undefined;

  const requestedEvents: Set<string> = rawEvents
    ? new Set(rawEvents.split(',').map((e: string) => e.trim()).filter((e: string) => ALL_ALLOWED.has(e)))
    : new Set(ALL_ALLOWED);

  if (requestedEvents.size === 0) {
    return res.status(400).json({ error: 'No valid event types specified. Valid: ' + [...ALL_ALLOWED].join(', ') });
  }

  // getSubClient is synchronous and returns Redis | null (shared singleton)
  const subscriber = getSubClient();

  if (!subscriber) {
    return res.status(503).json({ error: 'Event stream unavailable: Redis not configured' });
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  // Send initial connection ack
  res.write(`event: connection.ack\ndata: {"connected":true,"org_id":"${orgId}"}\n\n`);

  // Subscribe to org-scoped Redis channel
  const channel = `realtime:org:${orgId}`;

  const messageHandler = (_chan: string, message: string) => {
    try {
      const event = JSON.parse(message);
      const eventType: string = event.type;

      // Filter by requested event types
      if (!requestedEvents.has(eventType)) return;

      // Filter by phone_number_id if specified
      if (phoneNumberId && event.phone_number_id && event.phone_number_id !== phoneNumberId) return;

      // Filter by inbox_id if specified
      if (inboxId && event.inbox_id && event.inbox_id !== inboxId) return;

      // Write SSE event
      res.write(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`);
    } catch (err) {
      logger.warn('SSE: Failed to parse redis message', { error: err });
    }
  };

  try {
    subscriber.on('message', messageHandler);
    await subscriber.subscribe(channel);

    // Heartbeat to keep connection alive (every 30s)
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 30_000);

    const cleanup = () => {
      clearInterval(heartbeat);
      subscriber.off('message', messageHandler);
      subscriber.unsubscribe(channel).catch(() => {});
    };

    req.on('close', cleanup);
    req.on('error', cleanup);

  } catch (err: any) {
    logger.error('SSE stream error', { orgId, error: err.message });
    subscriber.off('message', messageHandler);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to connect to event stream' });
    } else {
      res.end();
    }
  }
});

export default router;
