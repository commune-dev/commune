import { startInboundEmailWorker } from './inboundEmailWorker';
import { startWebhookFanoutWorker } from './webhookFanoutWorker';
import { startOutboundEmailWorker } from './outboundEmailWorker';
import logger from '../utils/logger';
import 'dotenv/config';

logger.info('Starting Commune workers');

const inboundWorker = startInboundEmailWorker();
const fanoutWorker = startWebhookFanoutWorker();
const outboundWorker = startOutboundEmailWorker();

if (!inboundWorker && !fanoutWorker && !outboundWorker) {
  logger.error('No workers started — Redis not configured. Exiting.');
  process.exit(1);
}

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — closing workers gracefully');
  await Promise.allSettled([
    inboundWorker?.close(),
    fanoutWorker?.close(),
    outboundWorker?.close(),
  ]);
  process.exit(0);
});
