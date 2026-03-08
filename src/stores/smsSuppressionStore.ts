import { randomUUID } from 'crypto';
import { getCollection } from '../db';
import type { SmsSuppression, SmsSuppressionReason } from '../types/phone';

const col = () => getCollection<SmsSuppression>('sms_suppressions');

export const smsSuppressionStore = {
  /**
   * Check if a remote number is suppressed (opted out) for an org.
   * Checks both org-wide (phoneNumberId=null) and per-number suppressions.
   */
  async isSuppressed(orgId: string, remoteNumber: string, phoneNumberId?: string): Promise<boolean> {
    const c = await col();
    if (!c) return false;

    const query: Record<string, unknown> = {
      orgId,
      phoneNumber: remoteNumber,
    };

    if (phoneNumberId) {
      // Check org-wide OR per-number suppression
      query.$or = [{ phoneNumberId: null }, { phoneNumberId }] as unknown[];
    } else {
      query.phoneNumberId = null;
    }

    const count = await c.countDocuments(query);
    return count > 0;
  },

  async addSuppression(
    orgId: string,
    remoteNumber: string,
    reason: SmsSuppressionReason,
    phoneNumberId?: string
  ): Promise<void> {
    const c = await col();
    if (!c) return;
    await c.updateOne(
      { orgId, phoneNumber: remoteNumber },
      {
        $set: {
          orgId,
          phoneNumber: remoteNumber,
          phoneNumberId: phoneNumberId ?? null,
          reason,
          createdAt: new Date(),
        },
        $setOnInsert: { id: randomUUID() },
      },
      { upsert: true }
    );
  },

  async removeSuppression(orgId: string, remoteNumber: string): Promise<void> {
    const c = await col();
    if (!c) return;
    await c.deleteOne({ orgId, phoneNumber: remoteNumber });
  },

  async listSuppressions(orgId: string, phoneNumberId?: string): Promise<SmsSuppression[]> {
    const c = await col();
    if (!c) return [];
    const query: Record<string, unknown> = { orgId };
    if (phoneNumberId) {
      query.$or = [{ phoneNumberId: null }, { phoneNumberId }] as unknown[];
    }
    return c.find(query).sort({ createdAt: -1 }).toArray() as Promise<SmsSuppression[]>;
  },
};
