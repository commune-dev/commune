/**
 * smsCache — Redis cache helpers for SMS hot paths.
 *
 * Two cache shapes:
 *   twilio:creds:{orgId}   → { sid, authToken (plaintext), messagingServiceSid }, TTL 1h
 *   phone:e164:{e164}      → { phoneNumberId, orgId }, TTL 5min
 *
 * All helpers are fire-and-forget on write and return null on read failure.
 * A cache miss or Redis unavailability is always safe — callers fall back to MongoDB.
 */

import { getRedisClient } from './redis';

const CREDS_TTL_SECONDS = 3600;       // 1 hour
const PHONE_LOOKUP_TTL_SECONDS = 300; // 5 minutes

// ─── Twilio subaccount credentials ────────────────────────────────

export interface CachedCreds {
  sid: string;
  authToken: string;           // plaintext — acceptable: Redis is internal, TTL is short
  messagingServiceSid: string;
}

export async function getCachedCreds(orgId: string): Promise<CachedCreds | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(`twilio:creds:${orgId}`);
    if (!raw) return null;
    return JSON.parse(raw) as CachedCreds;
  } catch {
    return null;
  }
}

export async function setCachedCreds(orgId: string, creds: CachedCreds): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.set(`twilio:creds:${orgId}`, JSON.stringify(creds), 'EX', CREDS_TTL_SECONDS);
  } catch {
    // Non-critical — miss on next read is safe
  }
}

export async function invalidateCachedCreds(orgId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.del(`twilio:creds:${orgId}`);
  } catch {
    // Non-critical
  }
}

// ─── Phone number E.164 → org lookup ──────────────────────────────

export interface CachedPhoneLookup {
  phoneNumberId: string;
  orgId: string;
}

export async function getCachedPhoneLookup(e164: string): Promise<CachedPhoneLookup | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(`phone:e164:${e164}`);
    if (!raw) return null;
    return JSON.parse(raw) as CachedPhoneLookup;
  } catch {
    return null;
  }
}

export async function setCachedPhoneLookup(e164: string, data: CachedPhoneLookup): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.set(`phone:e164:${e164}`, JSON.stringify(data), 'EX', PHONE_LOOKUP_TTL_SECONDS);
  } catch {
    // Non-critical
  }
}

export async function invalidateCachedPhoneLookup(e164: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.del(`phone:e164:${e164}`);
  } catch {
    // Non-critical
  }
}
