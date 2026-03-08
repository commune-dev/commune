import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import type { ApiKey } from '../types';
import { getCollection } from '../db';
import { hmacApiKey, verifyApiKeyHmac, isHmacConfigured } from '../lib/hmacApiKey';
import { getRedisClient } from '../lib/redis';
import logger from '../utils/logger';

// In-memory API key cache - eliminates DB lookup on cache hit
const API_KEY_CACHE_TTL_MS = 60_000; // 60 seconds
interface CachedApiKey {
  keyRecord: ApiKey;
  orgId: string;
  keyHashV2?: string;
  expiresAt: number;
}
const apiKeyCache: Map<string, CachedApiKey> = new Map();

export function invalidateApiKeyCache(keyPrefix: string): void {
  apiKeyCache.delete(keyPrefix);
}

export class ApiKeyService {
  private static readonly KEY_PREFIX = 'comm_';
  private static readonly KEY_LENGTH = 32;

  static async generateApiKey(data: {
    orgId: string;
    name: string;
    permissions?: string[];
    expiresIn?: number;
    createdBy: string;
    isAdmin?: boolean;
  }): Promise<{ apiKey: string; apiKeyData: ApiKey }> {
    const collection = await getCollection<ApiKey>('api_keys');
    if (!collection) throw new Error('Database not available');

    const randomPart = crypto.randomBytes(this.KEY_LENGTH).toString('hex');
    const apiKey = `${this.KEY_PREFIX}${randomPart}`;
    const keyPrefix = apiKey.substring(0, 12);

    const keyHash = await bcrypt.hash(apiKey, 12);

    const expiresAt = data.expiresIn
      ? new Date(Date.now() + data.expiresIn * 1000).toISOString()
      : undefined;

    const apiKeyData: ApiKey = {
      id: crypto.randomBytes(16).toString('hex'),
      orgId: data.orgId,
      name: data.name,
      keyPrefix,
      keyHash,
      keyHashV2: isHmacConfigured() ? hmacApiKey(apiKey) : undefined,
      permissions: data.permissions || ['read', 'write'],
      status: 'active',
      expiresAt,
      createdBy: data.createdBy,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...(data.isAdmin !== undefined && { isAdmin: data.isAdmin }),
    };

    await collection.insertOne(apiKeyData);
    return { apiKey, apiKeyData };
  }

  static async validateApiKey(apiKey: string): Promise<{ apiKey: ApiKey; orgId: string } | null> {
    const collection = await getCollection<ApiKey>('api_keys');
    if (!collection) return null;

    const keyPrefix = apiKey.substring(0, 12);

    // Fast path: check cache first
    const cached = apiKeyCache.get(keyPrefix);
    if (cached && cached.expiresAt > Date.now() && cached.keyHashV2) {
      if (!verifyApiKeyHmac(apiKey, cached.keyHashV2)) return null;
      // Update lastUsedAt fire-and-forget
      setImmediate(() => {
        collection.updateOne({ id: cached.keyRecord.id }, { $set: { lastUsedAt: new Date().toISOString() } })
          .catch(err => logger.error('lastUsedAt update failed', { err }));
      });
      return { apiKey: cached.keyRecord, orgId: cached.orgId };
    }

    // L2 cache: check Redis before hitting DB (shared across Railway replicas)
    const redis = getRedisClient();
    if (redis) {
      try {
        const redisData = await redis.get(`apikey:cache:${keyPrefix}`);
        if (redisData) {
          const parsed = JSON.parse(redisData) as { keyRecord: ApiKey; orgId: string; keyHashV2?: string };
          if (parsed.keyHashV2 && verifyApiKeyHmac(apiKey, parsed.keyHashV2)) {
            // Populate L1 cache too
            apiKeyCache.set(keyPrefix, {
              keyRecord: parsed.keyRecord,
              orgId: parsed.orgId,
              keyHashV2: parsed.keyHashV2,
              expiresAt: Date.now() + API_KEY_CACHE_TTL_MS,
            });
            setImmediate(() => {
              collection.updateOne({ id: parsed.keyRecord.id }, { $set: { lastUsedAt: new Date().toISOString() } })
                .catch(err => logger.error('lastUsedAt update failed', { err }));
            });
            return { apiKey: parsed.keyRecord, orgId: parsed.orgId };
          }
        }
      } catch (err) {
        logger.warn('Redis apikey cache read failed', { err });
      }
    }

    // DB lookup - compound index on { keyPrefix, status } makes this a fast covered query
    const keyRecord = await collection.findOne(
      { keyPrefix, status: 'active' },
      { projection: { id: 1, orgId: 1, keyHash: 1, keyHashV2: 1, permissions: 1, name: 1, expiresAt: 1, rateLimit: 1, limits: 1, scope: 1, phoneNumberIds: 1, isAdmin: 1 } }
    );
    if (!keyRecord) return null;

    // Check expiry
    if (keyRecord.expiresAt && new Date(keyRecord.expiresAt) < new Date()) {
      setImmediate(() => {
        collection.updateOne({ id: keyRecord.id }, { $set: { status: 'expired' } })
          .catch(err => logger.error('status expired update failed', { err }));
      });
      return null;
    }

    // HMAC fast path (new keys with keyHashV2)
    if (keyRecord.keyHashV2) {
      if (!verifyApiKeyHmac(apiKey, keyRecord.keyHashV2)) return null;
      // Populate L1 cache
      apiKeyCache.set(keyPrefix, {
        keyRecord,
        orgId: keyRecord.orgId,
        keyHashV2: keyRecord.keyHashV2,
        expiresAt: Date.now() + API_KEY_CACHE_TTL_MS,
      });
      // Populate L2 Redis cache
      if (redis) {
        redis.set(
          `apikey:cache:${keyPrefix}`,
          JSON.stringify({ keyRecord, orgId: keyRecord.orgId, keyHashV2: keyRecord.keyHashV2 }),
          'EX', 60
        ).catch(err => logger.warn('Redis apikey cache write failed', { err }));
      }
      // Fire-and-forget lastUsedAt
      setImmediate(() => {
        collection.updateOne({ id: keyRecord.id }, { $set: { lastUsedAt: new Date().toISOString() } })
          .catch(err => logger.error('lastUsedAt update failed', { err }));
      });
      return { apiKey: keyRecord, orgId: keyRecord.orgId };
    }

    // bcrypt slow path (old keys without keyHashV2)
    const isValid = await bcrypt.compare(apiKey, keyRecord.keyHash);
    if (!isValid) return null;

    // Backfill keyHashV2 on first successful bcrypt verify (zero-downtime migration)
    if (isHmacConfigured()) {
      const newHmac = hmacApiKey(apiKey);
      setImmediate(() => {
        collection.updateOne(
          { id: keyRecord.id },
          { $set: { keyHashV2: newHmac, lastUsedAt: new Date().toISOString() } }
        ).catch(err => logger.error('keyHashV2 backfill failed', { err }));
      });
      // Populate L1 cache with new HMAC
      apiKeyCache.set(keyPrefix, {
        keyRecord,
        orgId: keyRecord.orgId,
        keyHashV2: newHmac,
        expiresAt: Date.now() + API_KEY_CACHE_TTL_MS,
      });
      // Populate L2 Redis cache with new HMAC
      if (redis) {
        redis.set(
          `apikey:cache:${keyPrefix}`,
          JSON.stringify({ keyRecord, orgId: keyRecord.orgId, keyHashV2: newHmac }),
          'EX', 60
        ).catch(err => logger.warn('Redis apikey cache write failed', { err }));
      }
    } else {
      setImmediate(() => {
        collection.updateOne({ id: keyRecord.id }, { $set: { lastUsedAt: new Date().toISOString() } })
          .catch(err => logger.error('lastUsedAt update failed', { err }));
      });
    }

    return { apiKey: keyRecord, orgId: keyRecord.orgId };
  }

  static async listApiKeys(orgId: string): Promise<ApiKey[]> {
    const collection = await getCollection<ApiKey>('api_keys');
    if (!collection) return [];

    return collection.find({ orgId }).sort({ createdAt: -1 }).toArray();
  }

  static async getApiKeyById(id: string): Promise<ApiKey | null> {
    const collection = await getCollection<ApiKey>('api_keys');
    if (!collection) return null;
    return collection.findOne({ id });
  }

  static async revokeApiKey(orgId: string, keyId: string): Promise<boolean> {
    const collection = await getCollection<ApiKey>('api_keys');
    if (!collection) return false;

    // Fetch keyPrefix before revoking so we can invalidate the cache
    const existing = await collection.findOne({ id: keyId, orgId }, { projection: { keyPrefix: 1 } });
    if (existing?.keyPrefix) {
      invalidateApiKeyCache(existing.keyPrefix);
      const redis = getRedisClient();
      if (redis) {
        redis.del(`apikey:cache:${existing.keyPrefix}`).catch(() => {});
      }
    }

    const result = await collection.updateOne(
      { id: keyId, orgId },
      { $set: { status: 'inactive', updatedAt: new Date().toISOString() } }
    );

    return result.modifiedCount > 0;
  }

  static async rotateApiKey(orgId: string, keyId: string, createdBy: string): Promise<{ apiKey: string; apiKeyData: ApiKey } | null> {
    const collection = await getCollection<ApiKey>('api_keys');
    if (!collection) return null;

    const existingKey = await collection.findOne({ id: keyId, orgId });
    if (!existingKey) return null;

    // Invalidate L1 and L2 cache for the old key prefix
    if (existingKey.keyPrefix) {
      invalidateApiKeyCache(existingKey.keyPrefix);
      const redis = getRedisClient();
      if (redis) {
        redis.del(`apikey:cache:${existingKey.keyPrefix}`).catch(() => {});
      }
    }

    const randomPart = crypto.randomBytes(this.KEY_LENGTH).toString('hex');
    const apiKey = `${this.KEY_PREFIX}${randomPart}`;
    const keyPrefix = apiKey.substring(0, 12);
    const keyHash = await bcrypt.hash(apiKey, 12);

    const result = await collection.findOneAndUpdate(
      { id: keyId, orgId },
      {
        $set: {
          keyPrefix,
          keyHash,
          keyHashV2: isHmacConfigured() ? hmacApiKey(apiKey) : undefined,
          updatedAt: new Date().toISOString()
        }
      },
      { returnDocument: 'after' }
    );

    return result ? { apiKey, apiKeyData: result } : null;
  }

  static async updateApiKey(id: string, updates: Partial<ApiKey>): Promise<ApiKey | null> {
    const collection = await getCollection<ApiKey>('api_keys');
    if (!collection) return null;

    const result = await collection.findOneAndUpdate(
      { id },
      { $set: { ...updates, updatedAt: new Date().toISOString() } },
      { returnDocument: 'after' }
    );

    return result;
  }

  static async updateApiKeyLimits(
    keyId: string,
    orgId: string,
    limits?: { maxInboxes?: number; maxEmailsPerDay?: number }
  ): Promise<ApiKey | null> {
    const collection = await getCollection<ApiKey>('api_keys');
    if (!collection) return null;

    const update: any = limits
      ? { $set: { limits, updatedAt: new Date().toISOString() } }
      : { $unset: { limits: 1 }, $set: { updatedAt: new Date().toISOString() } };

    const result = await collection.findOneAndUpdate(
      { id: keyId, orgId },
      update,
      { returnDocument: 'after' }
    );

    return result;
  }

  static async countApiKeysByOrg(orgId: string): Promise<number> {
    const collection = await getCollection<ApiKey>('api_keys');
    if (!collection) return 0;
    return collection.countDocuments({ orgId, status: 'active' });
  }
}
