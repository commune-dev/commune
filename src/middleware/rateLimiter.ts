import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { Request, Response } from 'express';
import { getOrgTierLimits, TierType } from '../config/rateLimits';
import { resolveOrgTier } from '../lib/tierResolver';
import { getRedisClient } from '../lib/redis';
import logger from '../utils/logger';

function createRedisStore(prefix: string) {
  const client = getRedisClient();
  if (!client) return undefined; // graceful fallback to in-memory when Redis down

  return new RedisStore({
    sendCommand: (...args: string[]) => (client as any).call(...args),
    prefix: `rl:${prefix}:`,
  });
}

// In-memory store for rate limiting
// Maps: "orgId:endpoint:window" -> number of requests
const rateLimitStore = new Map<string, Array<{ timestamp: number }>>();

interface OrgRequest extends Request {
  orgId?: string;
  user?: { orgId?: string; role?: string };
  apiKey?: { orgId?: string };
}

const getOrgTier = async (req: OrgRequest): Promise<TierType> => {
  const orgId = req.orgId || req.user?.orgId || req.apiKey?.orgId;
  return resolveOrgTier(orgId);
};

// Custom key generator - uses orgId instead of IP
const orgKeyGenerator = (req: OrgRequest): string => {
  const orgId = req.orgId || req.user?.orgId || req.apiKey?.orgId || 'anonymous';
  return orgId;
};

// Clean up old timestamps
const cleanOldTimestamps = (key: string, windowMs: number) => {
  const now = Date.now();
  const entries = rateLimitStore.get(key) || [];
  const cleaned = entries.filter((entry) => now - entry.timestamp < windowMs);
  if (cleaned.length === 0) {
    rateLimitStore.delete(key);
  } else {
    rateLimitStore.set(key, cleaned);
  }
};

// Custom store for rate limiting
const createMemoryStore = (windowMs: number, max: number) => ({
  increment: (key: string) => {
    const now = Date.now();
    cleanOldTimestamps(key, windowMs);
    const entries = rateLimitStore.get(key) || [];
    entries.push({ timestamp: now });
    rateLimitStore.set(key, entries);
    return entries.length;
  },
  resetKey: (key: string) => {
    rateLimitStore.delete(key);
  },
  decrement: (key: string) => {
    const entries = rateLimitStore.get(key) || [];
    if (entries.length > 0) {
      entries.pop();
      rateLimitStore.set(key, entries);
    }
  },
});

// Email send rate limiter (most critical)
export const emailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: async (req: any) => {
    const tier = await getOrgTier(req);
    return getOrgTierLimits(tier).emailsPerHour;
  },
  keyGenerator: orgKeyGenerator,
  skip: async (req: any) => {
    // Enterprise tier orgs are not rate-limited for email sending
    const tier = await getOrgTier(req);
    return tier === 'enterprise';
  },
  handler: (req: any, res: Response) => {
    const orgId = orgKeyGenerator(req as OrgRequest);
    res.status(429).json({
      error: 'Rate limit exceeded for email sending',
      retryAfter: req.rateLimit?.resetTime,
      orgId,
    });
  },
  store: createRedisStore('email-hour'),
  standardHeaders: true,
  legacyHeaders: false,
});

// Daily email limiter
export const emailDailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: async (req: any) => {
    const tier = await getOrgTier(req);
    return getOrgTierLimits(tier).emailsPerDay;
  },
  keyGenerator: (req: any) => `${orgKeyGenerator(req as OrgRequest)}:daily`,
  skip: async (req: any) => {
    const tier = await getOrgTier(req);
    return tier === 'enterprise';
  },
  handler: (req: any, res: Response) => {
    res.status(429).json({
      error: 'Daily email rate limit exceeded',
      retryAfter: req.rateLimit?.resetTime,
    });
  },
  store: createRedisStore('email-day'),
  standardHeaders: true,
  legacyHeaders: false,
});

// Domain creation limiter
export const domainLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: async (req: any) => {
    const tier = await getOrgTier(req);
    return getOrgTierLimits(tier).domainsPerDay;
  },
  keyGenerator: (req: any) => `${orgKeyGenerator(req as OrgRequest)}:domains`,
  handler: (req: any, res: Response) => {
    res.status(429).json({
      error: 'Domain creation rate limit exceeded',
      retryAfter: req.rateLimit?.resetTime,
    });
  },
  store: createRedisStore('domain-day'),
  standardHeaders: true,
  legacyHeaders: false,
});

// Inbox creation limiter
export const inboxLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: async (req: any) => {
    const tier = await getOrgTier(req);
    return getOrgTierLimits(tier).inboxesPerDay;
  },
  keyGenerator: (req: any) => `${orgKeyGenerator(req as OrgRequest)}:inboxes`,
  handler: (req: any, res: Response) => {
    res.status(429).json({
      error: 'Inbox creation rate limit exceeded',
      retryAfter: req.rateLimit?.resetTime,
    });
  },
  store: createRedisStore('inbox-day'),
  standardHeaders: true,
  legacyHeaders: false,
});

// Feedback submission limiter — 10 per minute per org
export const feedbackLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  keyGenerator: (req: any) => `${orgKeyGenerator(req as OrgRequest)}:feedback`,
  handler: (_req: any, res: Response) => {
    res.status(429).json({ error: 'Feedback rate limit exceeded. Try again in a minute.' });
  },
  store: createRedisStore('feedback-min'),
  standardHeaders: true,
  legacyHeaders: false,
});
