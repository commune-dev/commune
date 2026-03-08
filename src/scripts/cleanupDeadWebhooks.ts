/**
 * cleanupDeadWebhooks.ts
 *
 * Marks all retrying webhook deliveries to dead/unreachable endpoints as dead,
 * and optionally clears the webhook URL from affected inboxes.
 *
 * Usage:
 *   npx ts-node -e "require('./src/scripts/cleanupDeadWebhooks')"
 * or add to package.json scripts:
 *   "cleanup:webhooks": "ts-node src/scripts/cleanupDeadWebhooks.ts"
 *
 * Set DEAD_ENDPOINTS env var to a comma-separated list of endpoints to purge.
 * If not set, defaults to known dead dev endpoints.
 */

import 'dotenv/config';
import { connect, getCollection } from '../db';

const DEFAULT_DEAD_ENDPOINTS = [
  'https://2975-112-134-133-32.ngrok-free.app/webhook/commune',
];

const main = async () => {
  const db = await connect();
  if (!db) {
    console.error('Could not connect to MongoDB');
    process.exit(1);
  }

  const endpoints = process.env.DEAD_ENDPOINTS
    ? process.env.DEAD_ENDPOINTS.split(',').map((e) => e.trim())
    : DEFAULT_DEAD_ENDPOINTS;

  console.log(`Cleaning up dead webhook endpoints:\n  ${endpoints.join('\n  ')}`);

  const deliveries = await getCollection('webhook_deliveries');
  if (!deliveries) {
    console.error('webhook_deliveries collection not available');
    process.exit(1);
  }

  // 1. Mark all retrying/pending deliveries to dead endpoints as dead
  const now = new Date().toISOString();
  const deliveryResult = await deliveries.updateMany(
    {
      endpoint: { $in: endpoints },
      status: { $in: ['retrying', 'pending'] },
    },
    {
      $set: {
        status: 'dead',
        dead_at: now,
        next_retry_at: null,
        last_error: 'Manually killed — endpoint permanently unreachable',
      },
    }
  );
  console.log(`Marked ${deliveryResult.modifiedCount} delivery record(s) as dead.`);

  // 2. Clear the webhook URL from inboxes that point to dead endpoints
  const inboxes = await getCollection('inboxes');
  if (!inboxes) {
    console.error('inboxes collection not available');
    process.exit(1);
  }

  const inboxResult = await inboxes.updateMany(
    { 'webhook.endpoint': { $in: endpoints } },
    { $unset: { webhook: '' } }
  );
  console.log(`Cleared webhook config from ${inboxResult.modifiedCount} inbox(es).`);

  console.log('Done.');
  process.exit(0);
};

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
