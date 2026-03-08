/**
 * SMS usage tracking using Redis atomic counters.
 * Falls back to no-limit if Redis is unavailable.
 *
 * Key schema:
 *   sms:d:{orgId}:{YYYY-MM-DD}             → daily total (TTL 48h)
 *   sms:d:{orgId}:{phoneNumberId}:{date}   → daily per-number (TTL 48h)
 *   sms:m:{orgId}:{YYYY-MM}               → monthly total (TTL 35d)
 */

import { getRedisClient } from '../lib/redis';
import logger from '../utils/logger';

const TTL_DAILY_SECS = 60 * 60 * 48;   // 48 hours
const TTL_MONTHLY_SECS = 60 * 60 * 24 * 35; // 35 days

function today(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

export const smsUsageStore = {
  /**
   * Increment usage counters after a successful send.
   * Fire-and-forget — never throws.
   */
  async recordSend(orgId: string, phoneNumberId: string): Promise<void> {
    const redis = getRedisClient();
    if (!redis) return;

    const date = today();
    const month = thisMonth();

    const keyDailyTotal = `sms:d:${orgId}:${date}`;
    const keyDailyNum   = `sms:d:${orgId}:${phoneNumberId}:${date}`;
    const keyMonthly    = `sms:m:${orgId}:${month}`;

    try {
      const pipeline = redis.pipeline();
      pipeline.incr(keyDailyTotal);
      pipeline.expire(keyDailyTotal, TTL_DAILY_SECS);
      pipeline.incr(keyDailyNum);
      pipeline.expire(keyDailyNum, TTL_DAILY_SECS);
      pipeline.incr(keyMonthly);
      pipeline.expire(keyMonthly, TTL_MONTHLY_SECS);
      await pipeline.exec();
    } catch (err) {
      logger.warn('smsUsageStore.recordSend failed', { error: err });
    }
  },

  /**
   * Get current usage counts for limit enforcement.
   * Returns zeros on Redis failure (fail open to avoid blocking legitimate sends).
   */
  async getUsage(orgId: string, phoneNumberId: string): Promise<{
    dailyTotal: number;
    dailyPerNumber: number;
    monthlyTotal: number;
  }> {
    const redis = getRedisClient();
    if (!redis) return { dailyTotal: 0, dailyPerNumber: 0, monthlyTotal: 0 };

    const date = today();
    const month = thisMonth();

    try {
      const [dailyTotal, dailyNum, monthly] = await Promise.all([
        redis.get(`sms:d:${orgId}:${date}`),
        redis.get(`sms:d:${orgId}:${phoneNumberId}:${date}`),
        redis.get(`sms:m:${orgId}:${month}`),
      ]);

      return {
        dailyTotal:     parseInt(dailyTotal  ?? '0', 10),
        dailyPerNumber: parseInt(dailyNum    ?? '0', 10),
        monthlyTotal:   parseInt(monthly     ?? '0', 10),
      };
    } catch (err) {
      logger.warn('smsUsageStore.getUsage failed', { error: err });
      return { dailyTotal: 0, dailyPerNumber: 0, monthlyTotal: 0 };
    }
  },

  /**
   * Get daily usage across all phone numbers for an org (for dashboard display).
   */
  async getDailyTotals(orgId: string, days = 7): Promise<Array<{ date: string; count: number }>> {
    const redis = getRedisClient();
    if (!redis) return [];

    try {
      const dates: string[] = [];
      for (let i = 0; i < days; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        dates.push(d.toISOString().slice(0, 10));
      }

      const keys = dates.map(d => `sms:d:${orgId}:${d}`);
      const values = await redis.mget(...keys);

      return dates.map((date, i) => ({
        date,
        count: parseInt(values[i] ?? '0', 10),
      }));
    } catch (err) {
      logger.warn('smsUsageStore.getDailyTotals failed', { error: err });
      return [];
    }
  },
};
