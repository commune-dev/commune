import { Request, Response, NextFunction } from 'express';
import DomainWarmupService from '../services/domainWarmupService';
import domainStore from '../stores/domainStore';
import logger from '../utils/logger';

interface OrgRequest extends Request {
  orgId?: string;
  user?: { orgId?: string; role?: string };
  apiKey?: { orgId?: string };
}

export const warmupGate = async (req: OrgRequest, res: Response, next: NextFunction) => {
  try {
    const body = req.body || {};
    let domainId = body.domainId || body.domain_id;

    // If inboxId provided, resolve domain from inbox
    const inboxId = body.inboxId || body.inbox_id;
    if (!domainId && inboxId) {
      const domainIdFromInbox = await domainStore.getDomainIdByInboxId(inboxId);
      if (domainIdFromInbox) domainId = domainIdFromInbox;
    }

    // If no domainId resolvable, skip warmup check
    // (will use default domain which is presumably warmed up)
    if (!domainId) return next();

    // Skip for admin users
    if (req.user?.role === 'admin') return next();

    const warmupService = DomainWarmupService.getInstance();

    // Check if warmup is bypassed (admin-graduated)
    if (await warmupService.isWarmupBypassed(domainId)) return next();

    const status = await warmupService.getWarmupStatus(domainId);

    // Set informational headers when in warmup
    if (status.in_warmup) {
      res.setHeader('X-Warmup-Status', 'active');
      res.setHeader('X-Warmup-Day', status.warmup_day.toString());
      res.setHeader('X-Warmup-Daily-Limit', status.daily_limit.toString());
      res.setHeader('X-Warmup-Sent-Today', status.sent_today.toString());
      res.setHeader('X-Warmup-Remaining', status.remaining_today.toString());
    }

    // If graduated, no limit
    if (status.graduated) return next();

    // Check if over daily warmup limit
    if (status.remaining_today <= 0) {
      return res.status(429).json({
        error: 'Domain warmup daily limit reached',
        warmup: {
          day: status.warmup_day,
          daily_limit: status.daily_limit,
          sent_today: status.sent_today,
          domain_age_days: status.domain_age_days,
          next_milestone: status.next_milestone,
          graduated_on_day: 15,
        },
        message: `This domain is ${status.domain_age_days} day(s) old and in warmup. Today's limit is ${status.daily_limit} emails. Send more tomorrow as the limit increases automatically.`,
      });
    }

    next();
  } catch (err) {
    // Fail open — don't block sends on warmup check errors
    logger.error('Warmup gate error:', { error: err });
    next();
  }
};
