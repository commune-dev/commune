import { Router } from 'express';
import { getCollection } from '../../db';
import { resolveOrgTier } from '../../lib/tierResolver';
import { getOrgTierLimits, TierType } from '../../config/rateLimits';
import { getRedisClient } from '../../lib/redis';
import logger from '../../utils/logger';

const router = Router();

/**
 * GET /v1/me/limits
 * Returns the authenticated org's tier, plan limits, and current usage.
 */
router.get('/limits', async (req: any, res) => {
  const orgId: string | undefined = req.orgId;
  if (!orgId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const tier = await resolveOrgTier(orgId);
    const limits = getOrgTierLimits(tier as TierType);

    // ── Inbox count ──────────────────────────────────────────────────────────
    // Inboxes are stored as an embedded array in domain documents.
    // Filter by inbox-level orgId for proper multi-tenant isolation.
    let inboxesCount = 0;
    try {
      const domainsCollection = await getCollection('domains');
      if (domainsCollection) {
        const result = await domainsCollection.aggregate([
          { $match: { 'inboxes.orgId': orgId } },
          { $unwind: '$inboxes' },
          { $match: { 'inboxes.orgId': orgId } },
          { $count: 'total' },
        ]).toArray();
        inboxesCount = result[0]?.total ?? 0;
      }
    } catch (err) {
      logger.warn('me/limits: failed to count inboxes', { orgId, err });
    }

    // ── Emails sent today ─────────────────────────────────────────────────────
    // Try Redis rate limiter key first (sliding window sorted set ZCARD for today's window).
    // Key format used by emailDailyRateLimiter: rl:email:day:<orgId>
    let emailsSentToday = 0;
    const redis = getRedisClient();
    if (redis) {
      try {
        const rlKey = `rl:email:day:${orgId}`;
        const count = await redis.zcard(rlKey);
        emailsSentToday = count;
      } catch (err) {
        logger.warn('me/limits: Redis daily email count failed, falling back to DB', { orgId, err });
        // Fall through to DB query
        emailsSentToday = -1;
      }
    }

    // Fallback: query messages collection for outbound emails today
    if (emailsSentToday < 0 || (!redis && emailsSentToday === 0)) {
      try {
        const messagesCollection = await getCollection('messages');
        if (messagesCollection) {
          const todayStart = new Date();
          todayStart.setUTCHours(0, 0, 0, 0);
          emailsSentToday = await messagesCollection.countDocuments({
            orgId,
            direction: 'outbound',
            channel: 'email',
            created_at: { $gte: todayStart.toISOString() },
          });
        }
      } catch (err) {
        logger.warn('me/limits: failed to count emails sent today from DB', { orgId, err });
        emailsSentToday = 0;
      }
    }

    // ── Rate limit window reset times ────────────────────────────────────────
    const now = new Date();
    const hourlyResetsAt = new Date(now);
    hourlyResetsAt.setUTCMinutes(0, 0, 0);
    hourlyResetsAt.setUTCHours(hourlyResetsAt.getUTCHours() + 1);

    const dailyResetsAt = new Date(now);
    dailyResetsAt.setUTCHours(24, 0, 0, 0);

    // Map internal tier names to user-facing plan names
    const planNameMap: Record<string, string> = {
      free: 'free',
      agent_pro: 'pro',
      business: 'business',
      enterprise: 'enterprise',
    };

    return res.json({
      data: {
        org_id: orgId,
        plan: planNameMap[tier] ?? tier,
        limits: {
          emails_per_hour: limits.emailsPerHour,
          emails_per_day: limits.emailsPerDay,
          inboxes: limits.maxInboxes === Infinity ? null : limits.maxInboxes,
          domains: limits.maxCustomDomains === Infinity ? null : limits.maxCustomDomains,
        },
        usage: {
          emails_sent_today: emailsSentToday,
          inboxes_count: inboxesCount,
        },
        rate_limit_windows: {
          hourly_resets_at: hourlyResetsAt.toISOString(),
          daily_resets_at: dailyResetsAt.toISOString(),
        },
      },
    });
  } catch (err) {
    logger.error('me/limits: unexpected error', { orgId, err });
    return res.status(500).json({ error: 'Failed to retrieve limits' });
  }
});

export default router;
