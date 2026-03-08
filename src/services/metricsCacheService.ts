import { getCollection } from '../db';
import monitoringService from './monitoringService';
import logger from '../utils/logger';

interface CachedMetrics {
  data: any;
  timestamp: number;
  timeWindow: string;
}

interface CacheEntry {
  [timeWindow: string]: CachedMetrics;
}

// In-memory cache for active inboxes
const metricsCache = new Map<string, CacheEntry>();
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const MAX_CACHE_SIZE = 1000; // Limit memory usage

// Get active inboxes (those with recent activity)
const getActiveInboxes = async (): Promise<string[]> => {
  try {
    const messages = await getCollection('messages');
    const deliveryEvents = await getCollection('delivery_events');
    
    if (!messages || !deliveryEvents) {
      logger.error('Database collections not available');
      return [];
    }
    
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    // Find inboxes with recent activity
    const [recentMessages, recentEvents] = await Promise.all([
      messages.aggregate([
        { $match: { created_at: { $gte: oneDayAgo } }},
        { $group: { _id: '$metadata.inbox_id' }},
        { $project: { inbox_id: '$_id' }}
      ]).toArray(),
      
      deliveryEvents.aggregate([
        { $match: { processed_at: { $gte: oneDayAgo } }},
        { $group: { _id: '$inbox_id' }},
        { $project: { inbox_id: '$_id' }}
      ]).toArray()
    ]);
    
    // Combine and deduplicate
    const activeInboxIds = new Set<string>();
    [...recentMessages, ...recentEvents].forEach(item => {
      if (item.inbox_id) {
        activeInboxIds.add(item.inbox_id);
      }
    });
    
    return Array.from(activeInboxIds);
  } catch (error) {
    logger.error('Error getting active inboxes', { error });
    return [];
  }
};

// Update cached metrics for an inbox
const updateCachedMetrics = async (inboxId: string): Promise<void> => {
  try {
    const timeWindows = ['1h', '24h', '7d'];
    
    for (const timeWindow of timeWindows) {
      const metrics = await monitoringService.calculateMetrics(inboxId, timeWindow);
      const cacheKey = `${inboxId}-${timeWindow}`;
      
      const existing = metricsCache.get(cacheKey);
      if (existing) {
        // Update existing entry
        existing[timeWindow] = {
          data: metrics,
          timestamp: Date.now(),
          timeWindow
        };
      } else {
        // Add new entry
        metricsCache.set(cacheKey, {
          [timeWindow]: {
            data: metrics,
            timestamp: Date.now(),
            timeWindow
          }
        });
      }
    }
  } catch (error) {
    logger.error('Error updating cached metrics', { inboxId, error });
  }
};

// Get metrics with cache fallback
const getCachedMetrics = async (inboxId: string, timeWindow: string): Promise<any> => {
  const cacheKey = `${inboxId}-${timeWindow}`;
  const cached = metricsCache.get(cacheKey);
  
  // Check cache hit
  if (cached && cached[timeWindow]) {
    const cacheEntry = cached[timeWindow];
    if ((Date.now() - cacheEntry.timestamp) < CACHE_TTL) {
      logger.debug('Metrics cache hit', { cacheKey });
      return cacheEntry.data;
    }
  }

  // Cache miss - calculate and store
  logger.debug('Metrics cache miss, calculating', { cacheKey });
  const metrics = await monitoringService.calculateMetrics(inboxId, timeWindow);
  
  // Update cache
  if (cached) {
    cached[timeWindow] = {
      data: metrics,
      timestamp: Date.now(),
      timeWindow
    };
  } else {
    metricsCache.set(cacheKey, {
      [timeWindow]: {
        data: metrics,
        timestamp: Date.now(),
        timeWindow
      }
    });
  }
  
  // Clean up old entries if cache is too large
  if (metricsCache.size > MAX_CACHE_SIZE) {
    cleanupCache();
  }
  
  return metrics;
};

// Clean up old cache entries
const cleanupCache = (): void => {
  const now = Date.now();
  const keysToDelete: string[] = [];
  
  metricsCache.forEach((entry, key) => {
    // Find oldest entry in each cache group
    let oldestTimestamp = now;
    Object.values(entry).forEach(cacheEntry => {
      if (cacheEntry.timestamp < oldestTimestamp) {
        oldestTimestamp = cacheEntry.timestamp;
      }
    });
    
    // Remove if older than TTL and not recently accessed
    if (oldestTimestamp < (now - CACHE_TTL * 2)) {
      keysToDelete.push(key);
    }
  });
  
  keysToDelete.forEach(key => metricsCache.delete(key));
  logger.debug('Cleaned up old metrics cache entries', { count: keysToDelete.length });
};

// Get cache statistics
const getCacheStats = (): { size: number; hitRate: number } => {
  // This would need to be tracked with counters in a real implementation
  return {
    size: metricsCache.size,
    hitRate: 0 // Would be calculated from actual hit/miss ratios
  };
};

// Refresh cache for all active inboxes
const refreshAllActiveInboxes = async (): Promise<void> => {
  logger.debug('Starting metrics cache refresh for all active inboxes');
  const activeInboxes = await getActiveInboxes();

  const refreshPromises = activeInboxes.map(inboxId =>
    updateCachedMetrics(inboxId).catch(error => {
      logger.error('Failed to refresh metrics cache for inbox', { inboxId, error });
    })
  );

  await Promise.allSettled(refreshPromises);
  logger.debug('Metrics cache refresh complete', { count: activeInboxes.length });
};

// Clear cache for specific inbox (useful for testing)
const clearInboxCache = (inboxId: string): void => {
  const keysToDelete: string[] = [];
  metricsCache.forEach((_, key) => {
    if (key.startsWith(`${inboxId}-`)) {
      keysToDelete.push(key);
    }
  });
  
  keysToDelete.forEach(key => metricsCache.delete(key));
  logger.debug('Cleared metrics cache for inbox', { inboxId });
};

export default {
  getCachedMetrics,
  updateCachedMetrics,
  refreshAllActiveInboxes,
  clearInboxCache,
  getCacheStats,
  getActiveInboxes
};
