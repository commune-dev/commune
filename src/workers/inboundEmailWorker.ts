import { Worker } from 'bullmq';
import { getBullMQConnection } from '../lib/redis';
import { handleInboundWebhook } from '../services/email/inboundWebhook';
import logger from '../utils/logger';

export function startInboundEmailWorker(): Worker | null {
  const connection = getBullMQConnection();
  if (!connection) {
    logger.warn('Redis not available — inbound email worker not started');
    return null;
  }

  const worker = new Worker(
    'inbound-email',
    async (job) => {
      const { domainId, payload, headers } = job.data;
      const result = await handleInboundWebhook({ domainId, payload, headers });
      if ('error' in result && result.error) {
        const err = result.error;
        throw new Error(typeof err === 'string' ? err : JSON.stringify(err));
      }
      return 'data' in result ? result.data : null;
    },
    {
      connection,
      concurrency: 20,
    }
  );

  worker.on('failed', (job, err) => {
    logger.error('Inbound email job failed', {
      jobId: job?.id,
      error: err.message,
      attempt: job?.attemptsMade,
    });
  });

  worker.on('completed', (job) => {
    logger.debug('Inbound email job completed', { jobId: job.id });
  });

  logger.info('Inbound email worker started', { concurrency: 20 });
  return worker;
}
