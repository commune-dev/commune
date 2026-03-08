import { Router } from 'express';
import { z } from 'zod';
import { sendSms, handleInboundSms } from '../../services/sms/smsService';
import { smsSuppressionStore } from '../../stores/smsSuppressionStore';
import messageStore from '../../stores/messageStore';
import { getCollection } from '../../db';
import { requirePhoneScoped, requireSmsCredits, requireSmsRateLimit } from '../../middleware/smsGate';
import { requireAdminApiKey, requirePermission } from '../../middleware/permissions';
import { smsUsageStore } from '../../stores/smsUsageStore';
import { smsPerNumberRateLimiter } from '../../lib/redisRateLimiter';
import { resolveOrgTier } from '../../lib/tierResolver';
import { hasFeature } from '../../config/rateLimits';
import { decrypt } from '../../lib/encryption';
import logger from '../../utils/logger';

/** Strip internal fields from SMS messages before returning to API consumers */
function serializeSmsMessage(msg: any) {
  const meta = msg.metadata ?? {};
  return {
    message_id: msg.message_id,
    thread_id: msg.thread_id,
    direction: msg.direction,
    content: msg.content ?? null,
    created_at: msg.created_at,
    metadata: {
      delivery_status: meta.delivery_status ?? null,
      from_number: meta.from_number ?? null,
      to_number: meta.to_number ?? null,
      phone_number_id: meta.phone_number_id ?? meta.inbox_id ?? null,
      message_sid: meta.twilio_sid ?? null,
      credits_charged: meta.credits_charged ?? null,
      sms_segments: meta.sms_segments ?? null,
      has_attachments: meta.has_attachments ?? false,
      mms_media: meta.mms_media ?? null,
      delivery_data: meta.delivery_data ?? null,
    },
  };
}

/** Decrypt a preview string if encrypted, truncate to 120 chars */
function decryptPreview(preview: string | null | undefined): string | null {
  if (!preview) return null;
  try {
    const raw = preview.startsWith('enc:') ? decrypt(preview) : preview;
    return raw.length > 120 ? raw.slice(0, 120) + '…' : raw;
  } catch {
    return null;
  }
}

const router = Router();

const SendSmsSchema = z.object({
  to: z.string().regex(/^\+[1-9]\d{6,14}$/, 'to must be a valid E.164 phone number'),
  body: z.string().min(1).max(1600),
  phone_number_id: z.string().optional(),
  media_url: z.array(z.string().url()).max(10).optional(),
  validity_period: z.number().int().min(1).max(14400).optional(),
});

// ─── POST /sms/send ──────────────────────────────────────────────

router.post(
  '/send',
  requirePermission('sms:write'),
  requirePhoneScoped,
  requireSmsRateLimit,        // org-level daily/monthly anti-spam limits
  smsPerNumberRateLimiter as any,
  requireSmsCredits,
  async (req: any, res) => {
    const orgId: string = req.orgId;

    // Feature gate
    const tier = await resolveOrgTier(orgId);
    if (!hasFeature(tier, 'smsMessaging')) {
      return res.status(403).json({ error: 'plan_upgrade_required', feature: 'smsMessaging' });
    }

    const parsed = SendSmsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    }

    try {
      const result = await sendSms(parsed.data, orgId);
      // Record usage for anti-spam tracking (fire and forget)
      if (result.message_id && parsed.data.phone_number_id) {
        smsUsageStore.recordSend(orgId, parsed.data.phone_number_id).catch(() => {});
      }
      return res.status(201).json({ data: result });
    } catch (err: any) {
      const code = err.code ?? 'send_failed';
      const status =
        code === 'insufficient_phone_credits' ? 402 :
        code === 'recipient_suppressed' ? 422 :
        code === 'recipient_blocked' ? 422 :
        code === 'recipient_not_allowed' ? 422 :
        code === 'no_phone_number' || code === 'phone_number_not_active' ? 400 :
        code === 'twilio_not_provisioned' ? 503 :
        500;
      logger.warn('SMS send failed', { orgId, code, error: err.message });
      return res.status(status).json({ error: code, message: err.message });
    }
  }
);

// ─── GET /sms ────────────────────────────────────────────────────

router.get('/', requirePermission('sms:read'), requirePhoneScoped, async (req: any, res) => {
  try {
    const orgId: string = req.orgId;
    const phoneNumberId = req.query.phone_number_id as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string ?? '20', 10), 100);

    let messages;
    if (phoneNumberId) {
      messages = await messageStore.getMessagesByInbox({
        inboxId: phoneNumberId,
        channel: 'sms',
        limit,
        order: 'desc',
        orgId,
        before: req.query.before as string | undefined,
        after: req.query.after as string | undefined,
      });
    } else {
      messages = await messageStore.getMessagesByDomain({
        domainId: orgId, // no domain for SMS — use orgId as fallback scan
        channel: 'sms',
        limit,
        order: 'desc',
        orgId,
        before: req.query.before as string | undefined,
        after: req.query.after as string | undefined,
      });
    }

    return res.json({ data: messages.map(serializeSmsMessage) });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /sms/conversations ───────────────────────────────────────
// Returns SMS-specific conversation list with remote_number

router.get('/conversations', requirePermission('sms:read'), requirePhoneScoped, async (req: any, res) => {
  try {
    const orgId: string = req.orgId;
    const limit = Math.min(parseInt((req.query.limit as string) ?? '50', 10), 100);
    const phoneNumberId = req.query.phone_number_id as string | undefined;
    const cursor = req.query.cursor as string | undefined;

    const messages = await getCollection('messages');
    if (!messages) return res.json({ data: [], next_cursor: null });

    const matchFilter: Record<string, unknown> = { orgId, channel: 'sms' };
    if (phoneNumberId) matchFilter['metadata.inbox_id'] = phoneNumberId;

    // Cursor-based pagination
    let cursorFilter: Record<string, unknown> | null = null;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        cursorFilter = {
          $or: [
            { last_message_at: { $lt: decoded.last_message_at } },
            { last_message_at: decoded.last_message_at, _id: { $lt: decoded.id } },
          ],
        };
      } catch { /* ignore bad cursor */ }
    }

    const pipeline: Record<string, unknown>[] = [
      { $match: matchFilter },
      {
        // Compute remote_number per message: outbound→to_number, inbound→from_number
        $addFields: {
          remote_number: {
            $cond: [
              { $eq: ['$direction', 'outbound'] },
              '$metadata.to_number',
              '$metadata.from_number',
            ],
          },
        },
      },
      {
        $group: {
          _id: '$thread_id',
          remote_number: { $first: '$remote_number' },
          last_message_at: { $max: '$created_at' },
          last_message_preview: { $last: '$content' },
          message_count: { $sum: 1 },
          unread_count: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$direction', 'inbound'] }, { $ne: ['$metadata.read', true] }] },
                1,
                0,
              ],
            },
          },
        },
      },
      ...(cursorFilter ? [{ $match: cursorFilter }] : []),
      { $sort: { last_message_at: -1, _id: -1 } },
      { $limit: limit + 1 },
      {
        $project: {
          _id: 0,
          thread_id: '$_id',
          remote_number: 1,
          last_message_at: 1,
          last_message_preview: 1,
          message_count: 1,
          unread_count: 1,
        },
      },
    ];

    const results = await messages.aggregate(pipeline).toArray();

    let next_cursor: string | null = null;
    if (results.length > limit) {
      const last = results[limit - 1];
      next_cursor = Buffer.from(
        JSON.stringify({ last_message_at: last.last_message_at, id: last.thread_id })
      ).toString('base64url');
      results.splice(limit);
    }

    // Decrypt previews (stored encrypted for business/enterprise orgs)
    for (const r of results) {
      r.last_message_preview = decryptPreview(r.last_message_preview);
    }

    return res.json({ data: results, next_cursor });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /sms/conversations/:remoteNumber ─────────────────────────

router.get('/conversations/:remoteNumber', requirePermission('sms:read'), requirePhoneScoped, async (req: any, res) => {
  try {
    const orgId: string = req.orgId;
    const phoneNumberId = req.query.phone_number_id as string | undefined;

    if (!phoneNumberId) {
      return res.status(400).json({ error: 'phone_number_id query param required' });
    }

    // Thread ID is deterministic
    const crypto = await import('crypto');
    const remoteNumber = decodeURIComponent(req.params.remoteNumber);
    const normalized = remoteNumber.startsWith('+')
      ? '+' + remoteNumber.slice(1).replace(/\D/g, '')
      : remoteNumber;
    const threadId = crypto
      .createHash('sha256')
      .update(`${orgId}:${phoneNumberId}:${normalized}`)
      .digest('hex')
      .slice(0, 32);

    const messages = await messageStore.getMessagesByThread(threadId, 100, 'asc', orgId);
    return res.json({ data: messages.map(serializeSmsMessage), thread_id: threadId });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /sms/search ─────────────────────────────────────────────

router.get('/search', requirePermission('sms:read'), requirePhoneScoped, async (req: any, res) => {
  try {
    const orgId: string = req.orgId;
    const tier = await resolveOrgTier(orgId);
    if (!hasFeature(tier, 'semanticSearch')) {
      return res.status(403).json({ error: 'plan_upgrade_required', feature: 'semanticSearch' });
    }

    const q = req.query.q as string;
    if (!q) return res.status(400).json({ error: 'q query param required' });

    const { SearchService } = await import('../../services/searchService');
    const results = await SearchService.getInstance().search(
      orgId,
      q,
      {
        organizationId: orgId,
        channel: 'sms' as const,
        phoneNumberId: req.query.phone_number_id as string | undefined,
      },
      { limit: Math.min(parseInt(req.query.limit as string ?? '20', 10), 50) }
    );
    return res.json({ data: results });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /sms/suppressions ────────────────────────────────────────

router.get('/suppressions', requirePermission('sms:read'), async (req: any, res) => {
  try {
    const suppressions = await smsSuppressionStore.listSuppressions(
      req.orgId,
      req.query.phone_number_id as string | undefined
    );
    return res.json({ data: suppressions });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /sms/suppressions/:phoneNumber ────────────────────────

router.delete('/suppressions/:phoneNumber', requireAdminApiKey, requirePermission('sms:write'), async (req: any, res) => {
  try {
    const phoneNumber = decodeURIComponent(req.params.phoneNumber);
    await smsSuppressionStore.removeSuppression(req.orgId, phoneNumber);
    return res.json({ data: { removed: true, phone_number: phoneNumber } });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
