/**
 * Shared tier resolution with a single global cache.
 *
 * All middleware that needs the org's tier should use this module
 * instead of maintaining their own independent caches.
 *
 * The cache can be invalidated when a tier change occurs
 * (e.g., via Stripe webhook).
 */

import { getCollection } from '../db';
import { TierType } from '../config/rateLimits';
import type { Organization } from '../types';
import logger from '../utils/logger';

// Single global tier cache — 30s TTL (short enough that upgrades feel instant)
const tierCache = new Map<string, { tier: TierType; expiresAt: number }>();
const TIER_CACHE_TTL_MS = 30 * 1000;

// In-flight deduplication: when the cache expires, concurrent misses for the same
// orgId all share one DB promise instead of each launching an independent query.
const tierInFlight = new Map<string, Promise<TierType>>();

/**
 * Resolve the tier for an org. Uses a short-lived cache to avoid
 * hitting the DB on every request while keeping tier changes responsive.
 */
export async function resolveOrgTier(orgId: string | undefined | null): Promise<TierType> {
  if (!orgId) return 'free';

  const cached = tierCache.get(orgId);
  if (cached && cached.expiresAt > Date.now()) return cached.tier;

  // Deduplicate concurrent lookups for the same orgId so a cache expiry doesn't
  // cause a thundering herd of parallel DB queries.
  const existing = tierInFlight.get(orgId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const orgs = await getCollection<Organization>('organizations');
      if (orgs) {
        const org = await orgs.findOne({ id: orgId }, { projection: { tier: 1 } });
        const tier: TierType = (org?.tier as TierType) || 'free';
        tierCache.set(orgId, { tier, expiresAt: Date.now() + TIER_CACHE_TTL_MS });
        return tier;
      }
    } catch (error) {
      logger.warn('Failed to look up org tier, defaulting to free', { orgId, error });
    }
    return 'free' as TierType;
  })();

  tierInFlight.set(orgId, promise);
  try {
    return await promise;
  } finally {
    tierInFlight.delete(orgId);
  }
}

/**
 * Invalidate the cached tier for an org.
 * Call this when a tier change happens (Stripe webhook, admin action, etc.).
 */
export function invalidateTierCache(orgId: string): void {
  tierCache.delete(orgId);
  logger.info('Tier cache invalidated', { orgId });
}

/**
 * Invalidate all cached tiers. Useful for testing or emergency resets.
 */
export function invalidateAllTierCaches(): void {
  tierCache.clear();
}
