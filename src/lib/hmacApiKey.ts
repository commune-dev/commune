import { createHmac, timingSafeEqual } from 'crypto';
import logger from '../utils/logger';

// PERMANENT SECRET — do NOT rotate API_KEY_HMAC_SECRET without a full migration.
// Every API key's keyHashV2 is derived from this secret. If the secret changes,
// all backfilled HMAC hashes become invalid and keys fall back to slow bcrypt
// until each key re-authenticates and gets re-backfilled.
const HMAC_SECRET = process.env.API_KEY_HMAC_SECRET;

export function validateHmacConfig(): void {
  if (!HMAC_SECRET && process.env.NODE_ENV === 'production') {
    logger.warn('API_KEY_HMAC_SECRET not set — API key auth will use bcrypt fallback (slow)');
  }
}

export function hmacApiKey(apiKey: string): string {
  if (!HMAC_SECRET) throw new Error('API_KEY_HMAC_SECRET env var not set');
  return createHmac('sha256', HMAC_SECRET).update(apiKey).digest('hex');
}

export function verifyApiKeyHmac(apiKey: string, storedHmac: string): boolean {
  if (!HMAC_SECRET) return false;
  try {
    const expected = hmacApiKey(apiKey);
    return timingSafeEqual(Buffer.from(storedHmac, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

export function isHmacConfigured(): boolean {
  return !!HMAC_SECRET;
}
