import { Router } from 'express';
import crypto from 'crypto';
import emailService from '../../services/email';
import messageStore from '../../stores/messageStore';
import { requirePermission } from '../../middleware/permissions';
import { validate } from '../../middleware/validateRequest';
import { SendEmailSchema } from '../../lib/validation';
import logger from '../../utils/logger';
import { emailRateLimiter, emailDailyRateLimiter, outboundBurstDetector } from '../../lib/redisRateLimiter';
import { validateOutboundContent } from '../../middleware/spamPrevention';
import { sendingHealthGate } from '../../middleware/sendingHealthGate';
import { warmupGate } from '../../middleware/warmupGate';
import { enforceInboxDailyLimit } from '../../middleware/inboxLimits';
import { enforceApiKeyEmailLimit } from '../../middleware/apiKeyLimits';
import { getOutboundEmailQueue } from '../../workers/outboundEmailWorker';
import { checkIdempotency, storeIdempotencyResult } from '../../lib/idempotency';

const router = Router();

/**
 * POST /v1/messages/send
 * Send an email message.
 *
 * Body:
 *   to         - Recipient email(s): string or string[]
 *   subject    - Email subject line
 *   html       - HTML body (optional if text is provided)
 *   text       - Plain text body (optional if html is provided)
 *   from       - Sender email address (optional, uses default)
 *   cc         - CC recipients (optional)
 *   bcc        - BCC recipients (optional)
 *   reply_to   - Reply-to address (optional)
 *   thread_id  - Existing thread to reply to (optional)
 *   inboxId    - Inbox to send from (optional, recommended)
 *   domainId   - Domain to send from (optional, inferred from inboxId)
 *   attachments - Array of attachment IDs from upload (optional)
 */
router.post('/send', sendingHealthGate, warmupGate, emailRateLimiter, emailDailyRateLimiter, outboundBurstDetector, validateOutboundContent, requirePermission('messages:write'), validate(SendEmailSchema), enforceInboxDailyLimit, enforceApiKeyEmailLimit, async (req: any, res) => {
  const orgId: string | undefined = req.orgId;
  const payload = req.body;

  // Idempotency check — replay cached response if same key seen within 24h
  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
  if (idempotencyKey && orgId) {
    const existing = await checkIdempotency(orgId, idempotencyKey);
    if (existing) {
      res.set('Idempotency-Replayed', 'true');
      return res.status(existing.statusCode).json(existing.body);
    }
  }

  // Pre-generate message ID so the 202 response can include it
  const preGeneratedId = `msg_${crypto.randomUUID().replace(/-/g, '')}`;

  // Enqueue via BullMQ and return 202 immediately — no blocking wait.
  const queue = getOutboundEmailQueue();

  if (queue) {
    try {
      const job = await queue.add('send', { payload: { ...payload, orgId, _messageId: preGeneratedId } });
      logger.info('v1: Email queued', { orgId, jobId: job.id, to: payload.to, messageId: preGeneratedId });

      const responseBody = { data: { id: preGeneratedId, status: 'queued' } };

      if (idempotencyKey && orgId) {
        await storeIdempotencyResult(orgId, idempotencyKey, 202, responseBody);
      }

      return res.status(202).json(responseBody);
    } catch (err) {
      logger.error('v1: Email queue error', { orgId, error: err });
      return res.status(500).json({ error: 'Failed to queue email' });
    }
  }

  // Should not reach here (Redis is always available), but keep as safety net
  try {
    const result = await emailService.sendEmail({ ...payload, orgId: orgId || undefined });

    if (result.error) {
      return res.status(400).json({ error: result.error, validation: (result as any).validation });
    }

    const responseBody = { data: { id: preGeneratedId, status: 'queued' } };

    if (idempotencyKey && orgId) {
      await storeIdempotencyResult(orgId, idempotencyKey, 202, responseBody);
    }

    return res.status(202).json(responseBody);
  } catch (err) {
    logger.error('v1: Email send exception (no queue)', { orgId, error: err });
    return res.status(500).json({ error: 'Failed to send email' });
  }
});

/**
 * GET /v1/messages
 * List messages with filters.
 *
 * Query params:
 *   inbox_id  - Filter by inbox
 *   domain_id - Filter by domain
 *   sender    - Filter by sender identity
 *   limit     - Max results (1-1000, default 50)
 *   order     - 'asc' or 'desc' (default)
 *   before    - ISO date string, messages before this date
 *   after     - ISO date string, messages after this date
 */
router.get('/', requirePermission('messages:read'), async (req: any, res) => {
  const orgId = req.orgId;
  const { sender, before, after, limit: rawLimit, order, domain_id, inbox_id } = req.query;
  const limit = Math.min(Math.max(Number(rawLimit) || 50, 1), 1000);

  if (!sender && !domain_id && !inbox_id) {
    return res.status(400).json({ error: 'Provide at least one filter: sender, domain_id, or inbox_id' });
  }

  try {
    let data;
    if (inbox_id) {
      data = await messageStore.getMessagesByInbox({
        inboxId: inbox_id as string,
        before: before as string | undefined,
        after: after as string | undefined,
        limit,
        order: (order as 'asc' | 'desc') || 'desc',
        orgId,
      });
    } else if (domain_id) {
      data = await messageStore.getMessagesByDomain({
        domainId: domain_id as string,
        before: before as string | undefined,
        after: after as string | undefined,
        limit,
        order: (order as 'asc' | 'desc') || 'desc',
        orgId,
      });
    } else {
      data = await messageStore.getMessagesBySender({
        identity: sender as string,
        before: before as string | undefined,
        after: after as string | undefined,
        limit,
        order: (order as 'asc' | 'desc') || 'desc',
        orgId,
      });
    }

    return res.json({ data });
  } catch (err) {
    logger.error('v1: Failed to list messages', { orgId, error: err });
    return res.status(500).json({ error: 'Failed to list messages' });
  }
});

export default router;
