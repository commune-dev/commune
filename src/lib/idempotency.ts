import { getRedisClient } from './redis';
import logger from '../utils/logger';

export interface IdempotencyRecord {
  statusCode: number;
  body: unknown;
  createdAt: string;
}

const IDEMPOTENCY_TTL_SECS = 86400; // 24 hours

export async function checkIdempotency(
  orgId: string,
  key: string
): Promise<IdempotencyRecord | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  try {
    const stored = await redis.get(`idempotency:${orgId}:${key}`);
    if (!stored) return null;
    return JSON.parse(stored) as IdempotencyRecord;
  } catch (err) {
    logger.error('idempotency check failed', { err });
    return null;
  }
}

export async function storeIdempotencyResult(
  orgId: string,
  key: string,
  statusCode: number,
  body: unknown
): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    const record: IdempotencyRecord = { statusCode, body, createdAt: new Date().toISOString() };
    await redis.set(`idempotency:${orgId}:${key}`, JSON.stringify(record), 'EX', IDEMPOTENCY_TTL_SECS);
  } catch (err) {
    logger.warn('idempotency_store_failed — duplicate send possible on retry', { orgId, key: key.substring(0, 8) + '...', err });
  }
}
