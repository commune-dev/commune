import { Request, Response, NextFunction } from 'express';
import SendingHealthService from '../services/sendingHealthService';
import logger from '../utils/logger';

interface OrgRequest extends Request {
  orgId?: string;
  user?: { orgId?: string; role?: string };
  apiKey?: { orgId?: string };
}

export const sendingHealthGate = async (req: OrgRequest, res: Response, next: NextFunction) => {
  const orgId = req.orgId || req.user?.orgId || req.apiKey?.orgId;
  if (!orgId) return next(); // No org context — will fail auth later

  // Skip for admin users
  if (req.user?.role === 'admin') return next();

  try {
    const health = await SendingHealthService.getInstance().checkHealth(orgId);

    // Always set health headers (informational, even when healthy)
    res.setHeader('X-Sending-Health', health.status);
    res.setHeader('X-Bounce-Rate', health.bounce_rate.toFixed(4));
    res.setHeader('X-Complaint-Rate', health.complaint_rate.toFixed(4));

    if (!health.can_send) {
      return res.status(403).json({
        error: 'Sending paused due to high bounce/complaint rate',
        reason: health.paused_reason,
        health: {
          status: health.status,
          bounce_rate: health.bounce_rate,
          complaint_rate: health.complaint_rate,
          sent_24h: health.sent_24h,
          bounced_24h: health.bounced_24h,
          complained_24h: health.complained_24h,
        },
        resume_at: health.resume_at,
        action: 'Review your recipient list and remove invalid addresses. Sending will automatically resume after the cooldown period.',
      });
    }

    // Add warnings to response headers if approaching thresholds
    if (health.warnings.length > 0) {
      res.setHeader('X-Sending-Warnings', health.warnings.join('; '));
    }

    next();
  } catch (err) {
    // Fail open — don't block sends on health check errors
    logger.error('Sending health gate error:', { error: err });
    next();
  }
};
