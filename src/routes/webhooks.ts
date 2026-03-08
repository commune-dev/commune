import { Router, raw, json } from 'express';
import { Queue } from 'bullmq';
import emailService from '../services/email';
import domainService from '../services/domainService';
import { webhookRateGuard } from '../lib/redisRateLimiter';
import { getBullMQConnection } from '../lib/redis';
import logger from '../utils/logger';

const router = Router();
const LOG_FULL_WEBHOOKS = process.env.DEBUG_FULL_WEBHOOK_LOGS === 'true';
const INTERNAL_WEBHOOK_TOKEN = process.env.INTERNAL_WEBHOOK_TOKEN || '';

let inboundQueue: Queue | null = null;

function getInboundQueue(): Queue | null {
  if (inboundQueue) return inboundQueue;
  const connection = getBullMQConnection();
  if (!connection) return null;

  inboundQueue = new Queue('inbound-email', {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 500,
      removeOnFail: 2000,
    },
  });
  return inboundQueue;
}

const logWebhook = (payload: Record<string, unknown>) => {
  logger.debug('Webhook received', payload);
};

router.get('/info', (req, res) => {
  return res.json({
    endpoints: [
      'POST /api/webhooks/resend'
    ]
  });
});

const requireInternalToken = (req: any, res: any, next: any) => {
  if (!INTERNAL_WEBHOOK_TOKEN) {
    return res.status(403).json({ error: 'Domain webhook endpoints are disabled' });
  }
  const token = req.header('x-internal-token');
  if (!token || token !== INTERNAL_WEBHOOK_TOKEN) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  return next();
};

/**
 * Shared webhook for all domains. Resend now posts to /api/webhooks/resend.
 * Each inbound request carries its domainId in the query string; we verify
 * the raw body using the shared secret before routing the event to the inbox.
 */
router.post('/', webhookRateGuard, raw({ type: '*/*' }), async (req, res) => {
  const domainId = req.query.domainId as string | undefined;
  const payload = req.body.toString('utf8');

  const id = req.header('svix-id');
  const timestamp = req.header('svix-timestamp');
  const signature = req.header('svix-signature');

  logWebhook({
    tag: 'webhook.inbound',
    domainId,
    hasPayload: !!payload,
    payloadLength: payload.length,
    isBuffer: Buffer.isBuffer(req.body),
    bodyType: typeof req.body,
    headers: { id, timestamp, signature },
    rawBody: LOG_FULL_WEBHOOKS ? payload : undefined,
    rawBodyHex: LOG_FULL_WEBHOOKS ? Buffer.from(payload, 'utf8').toString('hex') : undefined,
    rawBodyBase64: LOG_FULL_WEBHOOKS ? Buffer.from(payload, 'utf8').toString('base64') : undefined,
  });

  if (!id || !timestamp || !signature) {
    logger.warn('Missing Svix headers', { id, timestamp, signature });
    return res.status(400).json({ error: 'Missing Svix headers' });
  }

  const queue = getInboundQueue();
  const emailId = (() => {
    try {
      const parsed = JSON.parse(req.body.toString('utf8'));
      return parsed?.data?.email_id || null;
    } catch {
      return null;
    }
  })();

  if (queue) {
    try {
      await queue.add(
        'process-email',
        {
          domainId: req.query.domainId as string | undefined,
          payload: req.body.toString('utf8'),
          headers: {
            id,
            timestamp,
            signature,
          },
          enqueuedAt: Date.now(),
        },
        {
          jobId: emailId ? `email:${emailId}` : undefined,
        }
      );
      return res.status(200).json({ ok: true, queued: true });
    } catch (err) {
      logger.warn('Failed to enqueue — falling back to synchronous processing', { error: err });
    }
  }

  // Fallback: synchronous processing (Redis down)
  const { data, error } = await emailService.handleInboundWebhook({
    domainId,
    payload,
    headers: { id, timestamp, signature },
  });

  if (error) {
    logger.warn('Webhook processing error', { error });
    return res.status(400).json({ error });
  }

  logger.debug('Webhook processed successfully');
  return res.json(data);
});

router.post('/domains/:domainId/webhook', requireInternalToken, json(), async (req, res) => {
  const { domainId } = req.params;
  const { endpoint, events } = req.body || {};

  const { data, error } = await domainService.createInboundWebhook(domainId, endpoint, events);

  if (error) {
    return res.status(400).json({ error });
  }

  return res.json({ data });
});

router.post('/domains/:domainId/webhook/secret', requireInternalToken, json(), async (req, res) => {
  const { domainId } = req.params;
  const { secret } = req.body || {};

  if (!secret) {
    return res.status(400).json({ error: 'Missing secret' });
  }

  const entry = await domainService.storeWebhookSecret(domainId, secret);
  if (!entry) {
    return res.status(400).json({ error: 'Failed to store secret' });
  }

  return res.json({ data: entry.webhook });
});


export default router;
