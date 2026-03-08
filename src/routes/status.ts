import { Router } from 'express';
import { connect } from '../db';
import { isRedisAvailable, getBullMQConnection } from '../lib/redis';
import { getCollection } from '../db';

const router = Router();

// ─── In-memory cache ──────────────────────────────────────────
type CacheEntry<T> = { data: T; expiresAt: number };
let statusCache: CacheEntry<object> | null = null;
let metricsCache: CacheEntry<object> | null = null;

function fromCache<T>(entry: CacheEntry<T> | null): T | null {
  if (entry && Date.now() < entry.expiresAt) return entry.data;
  return null;
}

// ─── Service status derivation ────────────────────────────────
type ServiceStatus = 'operational' | 'degraded' | 'down';

function deriveServices(mongoOk: boolean, redisOk: boolean, queueWorkersOk: boolean): Record<string, ServiceStatus> {
  // email: needs MongoDB (message store) + outbound worker
  const email: ServiceStatus = mongoOk && queueWorkersOk ? 'operational' : mongoOk ? 'degraded' : 'down';
  // sms + calls: backed by MongoDB for records, Twilio handles transport
  const sms: ServiceStatus = mongoOk ? 'operational' : 'down';
  const calls: ServiceStatus = mongoOk ? 'operational' : 'down';
  // webhooks: needs Redis (queue) + fanout worker
  const webhooks: ServiceStatus = redisOk && queueWorkersOk ? 'operational' : redisOk ? 'degraded' : 'down';

  return { email, sms, calls, webhooks };
}

// ─── GET /status ──────────────────────────────────────────────
// Public, no auth. Machine-readable operational status for agents.
// Cache: 30 seconds.
router.get('/status', async (_req, res) => {
  const cached = fromCache(statusCache);
  if (cached) return res.json(cached);

  // MongoDB check
  let mongoOk = false;
  let mongoLatencyMs: number | null = null;
  try {
    const t = Date.now();
    const db = await connect();
    if (db) {
      await db.command({ ping: 1 });
      mongoOk = true;
      mongoLatencyMs = Date.now() - t;
    }
  } catch {}

  // Redis check
  const redisOk = isRedisAvailable();

  // Queue worker check — fast, uses existing connection
  let queueWorkersOk = false;
  try {
    const conn = getBullMQConnection();
    if (conn) {
      const { Queue } = await import('bullmq');
      // Just check the outbound-email worker — representative of all workers
      const q = new Queue('outbound-email', { connection: conn });
      const workers = await q.getWorkers();
      queueWorkersOk = workers.length > 0;
      await q.close();
    }
  } catch {}

  const services = deriveServices(mongoOk, redisOk, queueWorkersOk);
  const operational = Object.values(services).every((s) => s === 'operational');

  const body = {
    operational,
    status: operational ? 'operational' : 'degraded',
    services,
    infrastructure: {
      database: mongoOk ? 'operational' : 'down',
      cache: redisOk ? 'operational' : 'down',
      ...(mongoLatencyMs !== null && { database_latency_ms: mongoLatencyMs }),
    },
    updated_at: new Date().toISOString(),
  };

  statusCache = { data: body, expiresAt: Date.now() + 30_000 };
  return res.json(body);
});

// ─── GET /status/metrics ─────────────────────────────────────
// Public, no auth. Platform-wide deliverability aggregate stats.
// Accurate data from MongoDB — no org filter, last 30 days.
// Cache: 1 hour.
router.get('/status/metrics', async (_req, res) => {
  const cached = fromCache(metricsCache);
  if (cached) return res.json(cached);

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const messages = await getCollection('messages');
    const webhookDeliveries = await getCollection('webhook_deliveries');

    // ── Email delivery metrics (all orgs, outbound only) ──────
    const emailResult = messages
      ? await messages.aggregate([
          {
            $match: {
              direction: 'outbound',
              channel: 'email',
              created_at: { $gte: since },
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              delivered: {
                $sum: { $cond: [{ $eq: ['$metadata.delivery_status', 'delivered'] }, 1, 0] },
              },
              bounced: {
                $sum: { $cond: [{ $eq: ['$metadata.delivery_status', 'bounced'] }, 1, 0] },
              },
              complained: {
                $sum: { $cond: [{ $eq: ['$metadata.delivery_status', 'complained'] }, 1, 0] },
              },
            },
          },
        ]).toArray()
      : [];

    // ── Webhook delivery metrics (all orgs) ───────────────────
    const webhookResult = webhookDeliveries
      ? await webhookDeliveries.aggregate([
          { $match: { created_at: { $gte: since } } },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              delivered: {
                $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] },
              },
              dead: {
                $sum: { $cond: [{ $eq: ['$status', 'dead'] }, 1, 0] },
              },
            },
          },
        ]).toArray()
      : [];

    const em = emailResult[0] || { total: 0, delivered: 0, bounced: 0, complained: 0 };
    const wh = webhookResult[0] || { total: 0, delivered: 0, dead: 0 };

    const emailTotal = em.total || 1; // avoid divide-by-zero
    const webhookTotal = wh.total || 1;

    const body = {
      period_days: 30,
      email: {
        total_sent: em.total,
        delivery_rate: parseFloat(((em.delivered / emailTotal) * 100).toFixed(2)),
        bounce_rate: parseFloat(((em.bounced / emailTotal) * 100).toFixed(2)),
        complaint_rate: parseFloat(((em.complained / emailTotal) * 100).toFixed(3)),
      },
      webhooks: {
        total_delivered: wh.total,
        delivery_rate: parseFloat((((wh.total - wh.dead) / webhookTotal) * 100).toFixed(2)),
        dead_letter_rate: parseFloat(((wh.dead / webhookTotal) * 100).toFixed(2)),
      },
      slo: {
        uptime_target_pct: 99.9,
        p95_response_time_target_ms: 200,  // was 500, updated after non-blocking send fix
        incident_detection_target_min: 3,
        credit_structure: '10% service credit per 0.1% below SLO, capped at 100% of monthly fee',
      },
      computed_at: new Date().toISOString(),
    };

    metricsCache = { data: body, expiresAt: Date.now() + 60 * 60 * 1000 };
    return res.json(body);
  } catch (err) {
    return res.status(503).json({ error: 'metrics_unavailable' });
  }
});

// ─── GET /status/shield ───────────────────────────────────────
// shields.io endpoint badge format — live colored status for GitHub READMEs.
// https://img.shields.io/endpoint?url=https%3A%2F%2Fapi.commune.email%2Fstatus%2Fshield
router.get('/status/shield', async (_req, res) => {
  const cached = fromCache(statusCache) as { operational?: boolean; status?: string } | null;

  let operational = true;
  let statusText = 'operational';

  if (cached) {
    operational = cached.operational ?? true;
    statusText = cached.status ?? 'operational';
  } else {
    try {
      const mongoOk = await (async () => {
        const db = await connect();
        if (!db) return false;
        await db.command({ ping: 1 });
        return true;
      })().catch(() => false);
      const redisOk = isRedisAvailable();
      const services = deriveServices(mongoOk, redisOk, true);
      operational = Object.values(services).every((s) => s === 'operational');
      statusText = operational ? 'operational' : 'degraded';
    } catch {
      statusText = 'degraded';
      operational = false;
    }
  }

  const color = operational ? 'brightgreen' : statusText === 'degraded' ? 'yellow' : 'red';

  res.json({
    schemaVersion: 1,
    label: 'api',
    message: statusText,
    color,
    cacheSeconds: 60,
  });
});

export default router;
