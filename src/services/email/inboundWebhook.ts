/**
 * DEPRECATED: Inbound email processing via Resend webhooks.
 *
 * This module is kept as a stub for backward compatibility with the BullMQ
 * inbound-email queue worker. Inbound email processing has been migrated to
 * AWS SES → SQS → sesInboundProcessor.ts. No new jobs will be enqueued here.
 */

import logger from '../../utils/logger';

export const handleInboundWebhook = async (_args: {
  domainId?: string;
  payload: string;
  headers: Record<string, string | undefined>;
}): Promise<{ data: { deprecated: true } }> => {
  logger.warn('handleInboundWebhook called — this path is deprecated, inbound email now processed via SES/SQS');
  return { data: { deprecated: true } };
};
