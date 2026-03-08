import { randomUUID } from 'crypto';
import { getCollection } from '../db';
import type { PhoneNumber } from '../types/phone';

const COOLDOWN_DAYS = 30;

const col = () => getCollection<PhoneNumber>('phone_numbers');

export const phoneNumberStore = {
  async getPhoneNumber(id: string, orgId: string): Promise<PhoneNumber | null> {
    const c = await col();
    if (!c) return null;
    return c.findOne({ id, orgId }) as Promise<PhoneNumber | null>;
  },

  async getPhoneNumberByTwilioSid(twilioSid: string): Promise<PhoneNumber | null> {
    const c = await col();
    if (!c) return null;
    return c.findOne({ twilioSid }) as Promise<PhoneNumber | null>;
  },

  async getPhoneNumberByE164(number: string, orgId: string): Promise<PhoneNumber | null> {
    const c = await col();
    if (!c) return null;
    return c.findOne({ number, orgId }) as Promise<PhoneNumber | null>;
  },

  async listPhoneNumbers(orgId: string): Promise<PhoneNumber[]> {
    const c = await col();
    if (!c) return [];
    return c.find({ orgId, status: { $ne: 'released' } }).sort({ createdAt: -1 }).toArray() as Promise<PhoneNumber[]>;
  },

  async countActivePhoneNumbers(orgId: string): Promise<number> {
    const c = await col();
    if (!c) return 0;
    return c.countDocuments({ orgId, status: 'active' });
  },

  async upsertPhoneNumber(pn: PhoneNumber): Promise<void> {
    const c = await col();
    if (!c) return;
    const { id, ...rest } = pn;
    await c.updateOne(
      { id },
      { $set: { ...rest, updatedAt: new Date() }, $setOnInsert: { id } },
      { upsert: true }
    );
  },

  async releasePhoneNumber(id: string, orgId: string): Promise<void> {
    const c = await col();
    if (!c) return;
    await c.updateOne(
      { id, orgId },
      { $set: { status: 'released', releasedAt: new Date(), updatedAt: new Date() } }
    );
  },

  async suspendForNonPayment(id: string): Promise<void> {
    const c = await col();
    if (!c) return;
    await c.updateOne(
      { id },
      { $set: { status: 'suspended_non_payment', updatedAt: new Date() } }
    );
  },

  async reactivate(id: string, orgId: string): Promise<void> {
    const c = await col();
    if (!c) return;
    await c.updateOne(
      { id, orgId },
      { $set: { status: 'active', updatedAt: new Date() } }
    );
  },

  /**
   * Check if org released a number within the cooldown period.
   * Prevents free-tier cycling of numbers to get different area codes.
   */
  async hasRecentRelease(orgId: string): Promise<boolean> {
    const c = await col();
    if (!c) return false;
    const cutoff = new Date(Date.now() - COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
    const count = await c.countDocuments({
      orgId,
      status: 'released',
      releasedAt: { $gte: cutoff },
    });
    return count > 0;
  },

  async updateAllowList(id: string, orgId: string, allowList: string[]): Promise<PhoneNumber | null> {
    const c = await col();
    if (!c) return null;
    await c.updateOne({ id, orgId }, { $set: { allowList, updatedAt: new Date() } });
    return this.getPhoneNumber(id, orgId);
  },

  async updateBlockList(id: string, orgId: string, blockList: string[]): Promise<PhoneNumber | null> {
    const c = await col();
    if (!c) return null;
    await c.updateOne({ id, orgId }, { $set: { blockList, updatedAt: new Date() } });
    return this.getPhoneNumber(id, orgId);
  },

  async update(id: string, orgId: string, fields: Partial<Pick<PhoneNumber, 'friendlyName' | 'autoReply' | 'webhook'>>): Promise<PhoneNumber | null> {
    const c = await col();
    if (!c) return null;
    await c.updateOne({ id, orgId }, { $set: { ...fields, updatedAt: new Date() } });
    return this.getPhoneNumber(id, orgId);
  },

  /**
   * Check if a remote number is allowed to interact with this phone number.
   * Block list always wins. Empty allow list = allow all.
   */
  async isNumberAllowed(id: string, orgId: string, remoteNumber: string): Promise<boolean> {
    const pn = await this.getPhoneNumber(id, orgId);
    if (!pn) return false;
    if (pn.blockList.includes(remoteNumber)) return false;
    if (pn.allowList.length === 0) return true;
    return pn.allowList.includes(remoteNumber);
  },

  async generateId(): Promise<string> {
    return `pn_${randomUUID().replace(/-/g, '')}`;
  },
};
