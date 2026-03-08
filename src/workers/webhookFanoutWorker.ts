import { Worker, Queue } from 'bullmq';
import { getBullMQConnection, getRedisClient } from '../lib/redis';
import logger from '../utils/logger';
import crypto from 'crypto';

export let webhookFanoutQueue: Queue | null = null;

export function getWebhookFanoutQueue(): Queue | null {
  if (webhookFanoutQueue) return webhookFanoutQueue;
  const connection = getBullMQConnection();
  if (!connection) return null;

  webhookFanoutQueue = new Queue('webhook-fanout', {
    connection,
    defaultJobOptions: {
      attempts: 8,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 1000,
    },
  });
  return webhookFanoutQueue;
}

function computeSignature(payload: unknown, secret: string): string {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export function startWebhookFanoutWorker(): Worker | null {
  const connection = getBullMQConnection();
  if (!connection) {
    logger.warn('Redis not available — webhook fanout worker not started');
    return null;
  }

  const worker = new Worker(
    'webhook-fanout',
    async (job) => {
      const { endpoint, payload, secret } = job.data;

      // Redis-backed circuit breaker
      const redis = getRedisClient();
      if (redis) {
        const circuitKey = `circuit:${Buffer.from(endpoint).toString('base64url').substring(0, 50)}`;
        const circuitOpen = await redis.get(circuitKey);
        if (circuitOpen) {
          throw new Error(`Circuit open for endpoint`);
        }
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);

      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (secret) {
          headers['X-Commune-Signature'] = computeSignature(payload, secret);
        }

        const response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`Webhook endpoint returned ${response.status}`);
        }
      } catch (err) {
        clearTimeout(timeoutId);

        // Open circuit breaker after 5 consecutive failures
        if (job.attemptsMade >= 5 && redis) {
          const circuitKey = `circuit:${Buffer.from(endpoint).toString('base64url').substring(0, 50)}`;
          await redis.set(circuitKey, '1', 'PX', 300_000); // 5 min
        }
        throw err;
      }
    },
    {
      connection,
      concurrency: 20,
    }
  );

  worker.on('failed', (job, err) => {
    logger.error('Webhook fanout job failed', {
      jobId: job?.id,
      error: err.message,
      attempt: job?.attemptsMade,
    });
  });

  logger.info('Webhook fanout worker started', { concurrency: 20 });
  return worker;
}
