import { Router } from 'express';
import { Queue } from 'bullmq';
import { connect } from '../db';
import { isRedisAvailable, getBullMQConnection } from '../lib/redis';

const router = Router();

const QUEUE_NAMES = ['inbound-email', 'outbound-email', 'webhook-fanout'] as const;

// Lightweight healthcheck used by Railway for zero-downtime deploys
router.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Deep healthcheck for monitoring tools (BetterStack, Grafana, etc.)
// Returns 503 if any critical dependency is down.
// NOT used by Railway — use /health for that.
router.get('/health/deep', async (_req, res) => {
  const start = Date.now();
  const checks: Record<string, any> = {};

  // MongoDB connectivity
  try {
    const dbStart = Date.now();
    const db = await connect();
    if (db) {
      await db.command({ ping: 1 });
      checks.mongodb = { ok: true, latencyMs: Date.now() - dbStart };
    } else {
      checks.mongodb = { ok: false, error: 'not_connected' };
    }
  } catch (err) {
    checks.mongodb = { ok: false, error: err instanceof Error ? err.message : 'unknown' };
  }

  // Redis connectivity
  checks.redis = {
    ok: isRedisAvailable(),
    ...(!isRedisAvailable() && { error: 'not_connected_or_not_configured' }),
  };

  // BullMQ queue health — checks each worker queue for stalled/failed jobs and live workers
  const connection = getBullMQConnection();
  if (connection) {
    const queueChecks: Record<string, any> = {};
    await Promise.all(
      QUEUE_NAMES.map(async (name) => {
        const queue = new Queue(name, { connection });
        try {
          const [counts, workers] = await Promise.all([
            queue.getJobCounts('waiting', 'active', 'failed', 'delayed', 'paused'),
            queue.getWorkers(),
          ]);
          const hasWorkers = workers.length > 0;
          // Flag degraded if no workers registered or excessive failed jobs
          const ok = hasWorkers && counts.failed < 50;
          queueChecks[name] = {
            ok,
            workers: workers.length,
            counts,
            ...(!hasWorkers && { error: 'no_workers_registered' }),
            ...(counts.failed >= 50 && { error: 'high_failed_job_count' }),
          };
        } catch (err) {
          queueChecks[name] = { ok: false, error: err instanceof Error ? err.message : 'unknown' };
        } finally {
          await queue.close();
        }
      })
    );
    checks.queues = {
      ok: Object.values(queueChecks).every((q) => q.ok),
      detail: queueChecks,
    };
  } else {
    checks.queues = { ok: false, error: 'redis_unavailable' };
  }

  const allOk = Object.values(checks).every((c) => c.ok);
  const status = allOk ? 200 : 503;

  res.status(status).json({
    ok: allOk,
    latencyMs: Date.now() - start,
    checks,
    replica: process.env.RAILWAY_REPLICA_ID ?? 'local',
    region: process.env.RAILWAY_REPLICA_REGION ?? 'local',
  });
});

export default router;
