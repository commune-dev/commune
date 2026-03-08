import { Request, Response, NextFunction } from 'express';
import { getRedisClient, isRedisAvailable } from './redis';
import { getOrgTierLimits, TierType } from '../config/rateLimits';
import { resolveOrgTier } from './tierResolver';
import logger from '../utils/logger';

// ─── Lua Scripts ────────────────────────────────────────────────────────────
// Sliding-window counter using Redis sorted sets.
// KEYS[1] = rate limit key
// ARGV[1] = current timestamp (ms)
// ARGV[2] = window size (ms)
// ARGV[3] = max requests
// ARGV[4] = unique member id (timestamp + random)
// Returns: [current_count, is_allowed (1/0), ttl_ms]
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

-- Remove expired entries
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

-- Count current entries
local count = redis.call('ZCARD', key)

if count < limit then
  -- Add the new request
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return {count + 1, 1, 0}
else
  -- Get the oldest entry to calculate retry-after
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry_after = 0
  if #oldest >= 2 then
    retry_after = tonumber(oldest[2]) + window - now
  end
  return {count, 0, retry_after}
end
`;

// ─── Burst detection Lua script ─────────────────────────────────────────────
// Uses a sliding window to detect per-second and per-minute bursts.
// KEYS[1] = burst key (e.g., "burst:org:<orgId>:send")
// ARGV[1] = current timestamp (ms)
// ARGV[2] = short window (ms) — e.g., 10_000 for 10s
// ARGV[3] = short window max
// ARGV[4] = long window (ms) — e.g., 60_000 for 1min
// ARGV[5] = long window max
// ARGV[6] = unique member
// Returns: [short_count, long_count, is_burst (1/0), violation_type]
// violation_type: 0=none, 1=short_burst, 2=long_burst, 3=both
const BURST_DETECTION_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local short_window = tonumber(ARGV[2])
local short_max = tonumber(ARGV[3])
local long_window = tonumber(ARGV[4])
local long_max = tonumber(ARGV[5])
local member = ARGV[6]

-- Clean entries older than the long window
redis.call('ZREMRANGEBYSCORE', key, 0, now - long_window)

-- Add the new request
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, long_window)

-- Count entries in short window
local short_count = redis.call('ZCOUNT', key, now - short_window, now)

-- Count entries in long window
local long_count = redis.call('ZCARD', key)

local violation = 0
if short_count > short_max then
  violation = violation + 1
end
if long_count > long_max then
  violation = violation + 2
end

return {short_count, long_count, violation > 0 and 1 or 0, violation}
`;

// ─── In-memory fallback ─────────────────────────────────────────────────────
const memoryStore = new Map<string, number[]>();

const memoryIncrement = (key: string, windowMs: number): number => {
  const now = Date.now();
  const entries = (memoryStore.get(key) || []).filter((ts) => now - ts < windowMs);
  entries.push(now);
  memoryStore.set(key, entries);
  return entries.length;
};

// Periodic cleanup every 60s
setInterval(() => {
  const now = Date.now();
  for (const [key, entries] of memoryStore.entries()) {
    const cleaned = entries.filter((ts) => now - ts < 86_400_000); // 24h max
    if (cleaned.length === 0) {
      memoryStore.delete(key);
    } else {
      memoryStore.set(key, cleaned);
    }
  }
}, 60_000);

// ─── Types ──────────────────────────────────────────────────────────────────
interface OrgRequest extends Request {
  orgId?: string;
  user?: { orgId?: string; role?: string; email?: string };
  apiKey?: { orgId?: string };
  rateLimit?: { resetTime?: number };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const getOrgTier = async (req: OrgRequest): Promise<TierType> => {
  const orgId = req.orgId || req.user?.orgId || req.apiKey?.orgId;
  return resolveOrgTier(orgId);
};

const getOrgId = (req: OrgRequest): string => {
  return req.orgId || req.user?.orgId || req.apiKey?.orgId || 'anonymous';
};

const shouldSkipRateLimit = async (req: OrgRequest): Promise<boolean> => {
  const tier = await getOrgTier(req);
  return tier === 'enterprise';
};

// ─── Rate limiter factory ───────────────────────────────────────────────────
interface RateLimiterOptions {
  windowMs: number;
  getMax: (req: OrgRequest) => Promise<number>;
  keyPrefix: string;
  errorMessage: string;
  keyGenerator?: (req: OrgRequest) => string;
  headerSuffix?: string; // e.g., 'Hour', 'Day' — namespaces X-RateLimit-* headers
}

const createRateLimiter = (opts: RateLimiterOptions) => {
  return async (req: OrgRequest, res: Response, next: NextFunction) => {
    if (await shouldSkipRateLimit(req)) return next();

    const keyId = opts.keyGenerator ? opts.keyGenerator(req) : getOrgId(req);
    const max = await opts.getMax(req);
    const key = `rl:${opts.keyPrefix}:${keyId}`;

    try {
      const redis = getRedisClient();
      if (redis && isRedisAvailable()) {
        const now = Date.now();
        const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;
        const result = (await redis.eval(
          SLIDING_WINDOW_SCRIPT,
          1,
          key,
          now.toString(),
          opts.windowMs.toString(),
          max.toString(),
          member
        )) as number[];

        const [count, allowed, retryAfterMs] = result;

        const sfx = opts.headerSuffix ? `-${opts.headerSuffix}` : '';
        res.setHeader(`X-RateLimit-Limit${sfx}`, max);
        res.setHeader(`X-RateLimit-Remaining${sfx}`, Math.max(0, max - count));
        res.setHeader(`X-RateLimit-Reset${sfx}`, Math.ceil((now + opts.windowMs) / 1000));

        if (!allowed) {
          res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000));
          return res.status(429).json({
            error: opts.errorMessage,
            retryAfter: Math.ceil(retryAfterMs / 1000),
          });
        }

        return next();
      }
    } catch (err) {
      logger.warn('Redis rate limiter error, falling back to memory', { error: err });
    }

    // Fallback to in-memory
    const count = memoryIncrement(key, opts.windowMs);
    const sfx = opts.headerSuffix ? `-${opts.headerSuffix}` : '';
    res.setHeader(`X-RateLimit-Limit${sfx}`, max);
    res.setHeader(`X-RateLimit-Remaining${sfx}`, Math.max(0, max - count));

    if (count > max) {
      return res.status(429).json({ error: opts.errorMessage });
    }

    return next();
  };
};

// ─── Burst detector ─────────────────────────────────────────────────────────
interface BurstConfig {
  shortWindowMs: number;   // e.g., 10 seconds
  shortWindowMax: number;  // e.g., 15 emails per 10s
  longWindowMs: number;    // e.g., 60 seconds
  longWindowMax: number;   // e.g., 50 emails per 60s
  keyPrefix: string;
}

const DEFAULT_BURST_CONFIG: BurstConfig = {
  shortWindowMs: 10_000,   // 10 seconds
  shortWindowMax: 15,      // max 15 emails per 10s
  longWindowMs: 60_000,    // 1 minute
  longWindowMax: 50,       // max 50 emails per minute
  keyPrefix: 'burst:send',
};

// In-memory burst tracking fallback
const memoryBurstStore = new Map<string, number[]>();

export const createBurstDetector = (config: BurstConfig = DEFAULT_BURST_CONFIG) => {
  return async (req: OrgRequest, res: Response, next: NextFunction) => {
    if (await shouldSkipRateLimit(req)) return next();

    const orgId = getOrgId(req);
    const key = `${config.keyPrefix}:${orgId}`;

    try {
      const redis = getRedisClient();
      if (redis && isRedisAvailable()) {
        const now = Date.now();
        const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;
        const result = (await redis.eval(
          BURST_DETECTION_SCRIPT,
          1,
          key,
          now.toString(),
          config.shortWindowMs.toString(),
          config.shortWindowMax.toString(),
          config.longWindowMs.toString(),
          config.longWindowMax.toString(),
          member
        )) as number[];

        const [shortCount, longCount, isBurst, violationType] = result;

        if (isBurst) {
          const reasons: string[] = [];
          if (violationType === 1 || violationType === 3) {
            reasons.push(`${shortCount} emails in ${config.shortWindowMs / 1000}s (max: ${config.shortWindowMax})`);
          }
          if (violationType === 2 || violationType === 3) {
            reasons.push(`${longCount} emails in ${config.longWindowMs / 1000}s (max: ${config.longWindowMax})`);
          }

          logger.warn('Outbound burst detected', {
            orgId,
            shortCount,
            longCount,
            violationType,
            reasons,
          });

          return res.status(429).json({
            error: 'Send rate too high — slow down',
            reasons,
            retryAfter: Math.ceil(config.shortWindowMs / 1000),
          });
        }

        return next();
      }
    } catch (err) {
      logger.warn('Redis burst detector error, falling back to memory', { error: err });
    }

    // In-memory fallback
    const now = Date.now();
    const entries = (memoryBurstStore.get(key) || []).filter(
      (ts) => now - ts < config.longWindowMs
    );
    entries.push(now);
    memoryBurstStore.set(key, entries);

    const shortCount = entries.filter((ts) => now - ts < config.shortWindowMs).length;

    if (shortCount > config.shortWindowMax || entries.length > config.longWindowMax) {
      logger.warn('Outbound burst detected (memory fallback)', {
        orgId,
        shortCount,
        longCount: entries.length,
      });

      return res.status(429).json({
        error: 'Send rate too high — slow down',
        retryAfter: Math.ceil(config.shortWindowMs / 1000),
      });
    }

    return next();
  };
};

// ─── Exported rate limiters ─────────────────────────────────────────────────
export const emailRateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  getMax: async (req) => {
    const tier = await getOrgTier(req);
    return getOrgTierLimits(tier).emailsPerHour;
  },
  keyPrefix: 'email:hour',
  errorMessage: 'Hourly email rate limit exceeded',
  headerSuffix: 'Hour',
});

export const emailDailyRateLimiter = createRateLimiter({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  getMax: async (req) => {
    const tier = await getOrgTier(req);
    return getOrgTierLimits(tier).emailsPerDay;
  },
  keyPrefix: 'email:day',
  errorMessage: 'Daily email rate limit exceeded',
  headerSuffix: 'Day',
});

export const domainRateLimiter = createRateLimiter({
  windowMs: 24 * 60 * 60 * 1000,
  getMax: async (req) => {
    const tier = await getOrgTier(req);
    return getOrgTierLimits(tier).domainsPerDay;
  },
  keyPrefix: 'domain:day',
  errorMessage: 'Domain creation rate limit exceeded',
  headerSuffix: 'Day',
});

export const inboxRateLimiter = createRateLimiter({
  windowMs: 24 * 60 * 60 * 1000,
  getMax: async (req) => {
    const tier = await getOrgTier(req);
    return getOrgTierLimits(tier).inboxesPerDay;
  },
  keyPrefix: 'inbox:day',
  errorMessage: 'Inbox creation rate limit exceeded',
  headerSuffix: 'Day',
});

export const outboundBurstDetector = createBurstDetector(DEFAULT_BURST_CONFIG);

// ─── Auth rate limiters (IP-based) ──────────────────────────────────────────
const getClientIp = (req: OrgRequest): string => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
};

export const authLoginRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  getMax: async () => 10,      // 10 login attempts per 15 min per IP
  keyPrefix: 'auth:login',
  errorMessage: 'Too many login attempts. Please try again in a few minutes.',
  keyGenerator: getClientIp,
});

export const authSignupRateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,   // 1 hour
  getMax: async () => 5,       // 5 signups per hour per IP
  keyPrefix: 'auth:signup',
  errorMessage: 'Too many signup attempts. Please try again later.',
  keyGenerator: getClientIp,
});

export const authPasswordResetRateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,   // 1 hour
  getMax: async () => 3,       // 3 password reset requests per hour per IP
  keyPrefix: 'auth:reset',
  errorMessage: 'Too many password reset requests. Please try again later.',
  keyGenerator: getClientIp,
});

// ─── Webhook rate limiters ──────────────────────────────────────────────────
// Two-tier approach: requests carrying Svix headers (from Resend/Svix) get a
// very generous limit. Requests without Svix headers (potential attackers
// probing the endpoint) get a strict IP-based limit.

// Generous limiter for verified Svix traffic — 100k req/min, effectively
// uncapped for realistic Resend volumes (worst case ~1500 req/min at 25 eps)
const webhookLimiterSvix = createRateLimiter({
  windowMs: 60 * 1000,
  getMax: async () => 100_000, // effectively uncapped for legitimate Resend traffic
  keyPrefix: 'webhook:svix',
  errorMessage: 'Webhook rate limit exceeded',
  keyGenerator: getClientIp,
});

// Strict limiter for requests with no Svix headers (no proof of Resend origin)
const webhookLimiterStrict = createRateLimiter({
  windowMs: 60 * 1000,
  getMax: async () => 60, // 60 req/min per IP for unverified sources
  keyPrefix: 'webhook:strict',
  errorMessage: 'Webhook rate limit exceeded — try again shortly',
  keyGenerator: getClientIp,
});

/**
 * webhookRateGuard: two-tier rate limiter for the Resend inbound webhook.
 *
 * Checks for Svix signature headers BEFORE rate-limiting. A request that
 * carries all three Svix headers (svix-id, svix-timestamp, svix-signature)
 * is almost certainly from Resend — route it through the generous limiter so
 * high-volume inbound traffic is never blocked. Requests missing those headers
 * (probes, scanners) hit the strict limit.
 *
 * Full signature verification happens inside the route handler (requires raw
 * body). The presence of all three headers is sufficient here to distinguish
 * legitimate Svix traffic from blind attackers.
 */
export const webhookRateGuard = (
  req: OrgRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const svixId = req.headers['svix-id'];
  const svixTimestamp = req.headers['svix-timestamp'];
  const svixSignature = req.headers['svix-signature'];

  if (svixId && svixTimestamp && svixSignature) {
    // All three Svix headers present — route through generous limiter
    return webhookLimiterSvix(req, res, next) as Promise<void>;
  }

  // No Svix headers — apply strict limit
  return webhookLimiterStrict(req, res, next) as Promise<void>;
};

/** @deprecated Use webhookRateGuard instead */
export const webhookRateLimiter = webhookRateGuard;

// ─── SMS rate limiters ───────────────────────────────────────────────────────

/** 1 SMS/sec per destination number (Twilio Messaging Service hard limit) */
export const smsPerNumberRateLimiter = createRateLimiter({
  windowMs: 1000,
  getMax: async () => 1,
  keyPrefix: 'sms:number:sec',
  errorMessage: 'SMS rate limit: maximum 1 message per second per destination number',
  keyGenerator: (req) => `${getOrgId(req)}:${req.body?.to ?? 'unknown'}`,
  headerSuffix: 'SmsNumber',
});

/** IP-based rate limiter for phone number purchases (anti-abuse) */
export const phoneNumberPurchaseRateLimiter = createRateLimiter({
  windowMs: 24 * 60 * 60 * 1000,
  getMax: async () => 5,
  keyPrefix: 'phone:purchase:ip',
  errorMessage: 'Too many phone number purchases from this IP. Try again tomorrow.',
  keyGenerator: getClientIp,
  headerSuffix: 'PhonePurchase',
});
