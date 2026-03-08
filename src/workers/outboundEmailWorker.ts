import { Worker, Queue, QueueEvents } from 'bullmq';
import { getBullMQConnection } from '../lib/redis';
import { sendEmail } from '../services/email/sendEmail';
import type { SendMessagePayload } from '../types';
import logger from '../utils/logger';

export interface OutboundEmailJobData {
  payload: SendMessagePayload & { orgId?: string; _messageId?: string };
}

let outboundEmailQueue: Queue | null = null;
let outboundEmailQueueEvents: QueueEvents | null = null;

export function getOutboundEmailQueue(): Queue | null {
  if (outboundEmailQueue) return outboundEmailQueue;

  const connection = getBullMQConnection();
  if (!connection) return null;

  outboundEmailQueue = new Queue('outbound-email', {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 500,
      removeOnFail: 2000,
    },
  });

  return outboundEmailQueue;
}

export function getOutboundEmailQueueEvents(): QueueEvents | null {
  if (outboundEmailQueueEvents) return outboundEmailQueueEvents;

  const connection = getBullMQConnection();
  if (!connection) return null;

  outboundEmailQueueEvents = new QueueEvents('outbound-email', { connection });
  return outboundEmailQueueEvents;
}

export function startOutboundEmailWorker(): Worker | null {
  const connection = getBullMQConnection();
  if (!connection) {
    logger.warn('Redis not available — outbound email worker not started');
    return null;
  }

  const worker = new Worker<OutboundEmailJobData>(
    'outbound-email',
    async (job) => {
      const { payload } = job.data;
      const result = await sendEmail(payload);

      if (result.error) {
        const err = result.error;
        const errMsg = typeof err === 'string' ? err : (err as { message?: string }).message || JSON.stringify(err);

        // Detect Resend 429 (rate limit) — throw so BullMQ retries with backoff
        if (errMsg.toLowerCase().includes('429') || errMsg.toLowerCase().includes('rate limit') || errMsg.toLowerCase().includes('too many requests')) {
          logger.warn('Outbound email 429 from Resend — will retry', {
            jobId: job.id,
            orgId: payload.orgId,
            attempt: job.attemptsMade + 1,
          });
          throw new Error(`Resend rate limit: ${errMsg}`);
        }

        // Non-retryable errors (suppressed, invalid recipients, missing from, etc.)
        logger.warn('Outbound email job completed with non-retryable error', {
          jobId: job.id,
          orgId: payload.orgId,
          error: errMsg,
        });
        // Return the error result — don't throw, no point retrying validation errors.
        // Preserve validation details (e.g. rejected[] array) so the route can pass them to the client.
        const errValidation = (result.error as any)?.validation;
        return { error: errMsg, ...(errValidation && { validation: errValidation }) };
      }

      logger.info('Outbound email job completed', {
        jobId: job.id,
        orgId: payload.orgId,
        messageId: result.data?.id,
        threadId: result.data?.thread_id,
      });

      return { data: result.data, validation: (result as any).validation };
    },
    {
      connection,
      concurrency: 5,
      limiter: {
        max: 5,
        duration: 1000,
      },
    }
  );

  worker.on('failed', (job, err) => {
    logger.error('Outbound email job failed', {
      jobId: job?.id,
      orgId: job?.data?.payload?.orgId,
      error: err.message,
      attempt: job?.attemptsMade,
    });
  });

  worker.on('completed', (job) => {
    logger.debug('Outbound email job completed', { jobId: job.id });
  });

  logger.info('Outbound email worker started', { concurrency: 5 });
  return worker;
}

export async function closeOutboundEmailConnections(): Promise<void> {
  await Promise.allSettled([
    outboundEmailQueue?.close(),
    outboundEmailQueueEvents?.close(),
  ]);
  outboundEmailQueue = null;
  outboundEmailQueueEvents = null;
}
