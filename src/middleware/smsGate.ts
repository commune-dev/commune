import { Request, Response, NextFunction } from 'express';
import { phoneNumberStore } from '../stores/phoneNumberStore';
import { creditStore } from '../stores/creditStore';
import { smsUsageStore } from '../stores/smsUsageStore';
import { resolveOrgTier } from '../lib/tierResolver';
import { getOrgTierLimits } from '../config/rateLimits';
import { getCreditCost, getCountryFromE164 } from '../config/smsCosts';
import { getCollection } from '../db';
import type { Organization } from '../types/auth';
import type { V1AuthenticatedRequest } from './agentSignatureAuth';

// ── Default anti-spam limits (per tier) ─────────────────────────
const DEFAULT_SMS_LIMITS = {
  maxSmsPerDayPerNumber: 500,
  maxSmsPerDayTotal:     2000,
  maxSmsPerMonth:        20000,
};

const getOrgId = (req: Request): string => {
  const r = req as any;
  return r.orgId ?? r.user?.orgId ?? r.apiKey?.orgId ?? '';
};

/**
 * Ensure phone-scoped API keys can only send from their assigned numbers.
 * Master keys pass through; phone-scoped keys must have req.body.phone_number_id
 * in their allowed list.
 */
export const requirePhoneScoped = (req: Request, res: Response, next: NextFunction): void => {
  const r = req as V1AuthenticatedRequest;
  if (r.authType !== 'apikey' || !r.apiKeyData) return next();

  const { scope, phoneNumberIds } = r.apiKeyData;
  if (!scope || scope === 'master') return next();

  // scope === 'phone': verify phone_number_id is in allowed list
  const fromId: string | undefined = req.body?.phone_number_id;
  if (!fromId || !phoneNumberIds?.includes(fromId)) {
    res.status(403).json({
      error: 'phone_key_not_authorized',
      message: 'This API key can only send from its assigned phone numbers',
    });
    return;
  }
  next();
};

/**
 * Verify the org hasn't exceeded their phone number quota.
 * Checks tier default first, then org-level override (set via dashboard).
 */
export const requirePhoneNumberQuota = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const orgId = getOrgId(req);
  if (!orgId) {
    res.status(401).json({ error: 'Unauthenticated' });
    return;
  }

  const tier = await resolveOrgTier(orgId);
  const tierLimits = getOrgTierLimits(tier);

  // Check if org has a custom override
  const orgs = await getCollection<Organization>('organizations');
  const org = orgs ? await orgs.findOne({ id: orgId }, { projection: { phoneSettings: 1 } }) : null;
  const max = org?.phoneSettings?.maxPhoneNumbers ?? tierLimits.maxPhoneNumbers;

  if (max === Infinity) return next();

  const count = await phoneNumberStore.countActivePhoneNumbers(orgId);
  if (count >= max) {
    res.status(403).json({
      error: 'phone_number_quota_reached',
      message: `Your account allows a maximum of ${max} phone number${max === 1 ? '' : 's'}. Adjust this in your dashboard settings.`,
      limit: max,
      current: count,
    });
    return;
  }
  next();
};

/**
 * Anti-spam: check org-level daily and monthly SMS send limits.
 * These limits are configured by a human via the dashboard and cannot be raised via the API.
 */
export const requireSmsRateLimit = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const orgId = getOrgId(req);
  if (!orgId) {
    res.status(401).json({ error: 'Unauthenticated' });
    return;
  }

  const phoneNumberId: string | undefined = req.body?.phone_number_id;
  if (!phoneNumberId) {
    // No phone number specified yet — let the handler deal with it
    return next();
  }

  // Load org-level overrides (set by human via dashboard)
  const orgs = await getCollection<Organization>('organizations');
  const org = orgs ? await orgs.findOne({ id: orgId }, { projection: { phoneSettings: 1 } }) : null;
  const settings = org?.phoneSettings;

  const maxPerDayPerNumber = settings?.maxSmsPerDayPerNumber ?? DEFAULT_SMS_LIMITS.maxSmsPerDayPerNumber;
  const maxPerDayTotal     = settings?.maxSmsPerDayTotal     ?? DEFAULT_SMS_LIMITS.maxSmsPerDayTotal;
  const maxPerMonth        = settings?.maxSmsPerMonth        ?? DEFAULT_SMS_LIMITS.maxSmsPerMonth;

  const usage = await smsUsageStore.getUsage(orgId, phoneNumberId);

  if (usage.dailyPerNumber >= maxPerDayPerNumber) {
    res.status(429).json({
      error: 'sms_daily_limit_per_number',
      message: `This phone number has reached its daily limit of ${maxPerDayPerNumber} messages. Resets at midnight UTC.`,
      limit: maxPerDayPerNumber,
      used: usage.dailyPerNumber,
      resets_at: 'midnight UTC',
    });
    return;
  }

  if (usage.dailyTotal >= maxPerDayTotal) {
    res.status(429).json({
      error: 'sms_daily_limit_total',
      message: `Your account has reached its daily limit of ${maxPerDayTotal} messages. Adjust in dashboard settings.`,
      limit: maxPerDayTotal,
      used: usage.dailyTotal,
      resets_at: 'midnight UTC',
    });
    return;
  }

  if (usage.monthlyTotal >= maxPerMonth) {
    res.status(429).json({
      error: 'sms_monthly_limit',
      message: `Your account has reached its monthly limit of ${maxPerMonth} messages. Adjust in dashboard settings.`,
      limit: maxPerMonth,
      used: usage.monthlyTotal,
    });
    return;
  }

  // Attach usage to request for logging
  (req as any).smsUsage = usage;
  next();
};

/**
 * Pre-flight check: verify the org has enough credits for the outbound SMS.
 * Attaches req.smsCreditsNeeded for the handler.
 */
export const requireSmsCredits = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const orgId = getOrgId(req);
  if (!orgId) {
    res.status(401).json({ error: 'Unauthenticated' });
    return;
  }

  const to: string | undefined = req.body?.to;
  const hasMedia = Array.isArray(req.body?.media_url) && req.body.media_url.length > 0;

  if (!to) {
    res.status(400).json({ error: 'Missing to field' });
    return;
  }

  const country = getCountryFromE164(to);
  const credits = getCreditCost(country, 'outbound', hasMedia ? 'mms' : 'sms');
  const balance = await creditStore.getBalance(orgId);

  if (balance.total < credits) {
    res.status(402).json({
      error: 'insufficient_phone_credits',
      message: `Sending this message requires ${credits} credits but your balance is ${balance.total}. Purchase more credits at /dashboard/billing.`,
      required: credits,
      balance: balance.total,
      top_up_url: 'https://commune.email/dashboard/billing',
    });
    return;
  }

  (req as any).smsCreditsNeeded = credits;
  next();
};
