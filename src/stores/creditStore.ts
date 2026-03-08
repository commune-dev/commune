import { getCollection } from '../db';
import type { CreditBalance } from '../types/phone';
import type { Organization } from '../types/auth';

export class InsufficientCreditsError extends Error {
  constructor(public required: number, public available: number) {
    super(`Insufficient phone credits: need ${required}, have ${available}`);
    this.name = 'InsufficientCreditsError';
  }
}

const orgs = () => getCollection<Organization>('organizations');

export const creditStore = {
  async getBalance(orgId: string): Promise<CreditBalance> {
    const c = await orgs();
    if (!c) return { included: 0, purchased: 0, total: 0, usedThisCycle: 0, cycleResetAt: new Date().toISOString() };

    const org = await c.findOne({ id: orgId }, { projection: { phoneCredits: 1 } });
    const credits = org?.phoneCredits;

    const included = credits?.included ?? 0;
    const purchased = credits?.purchased ?? 0;
    return {
      included,
      purchased,
      total: included + purchased,
      usedThisCycle: credits?.usedThisCycle ?? 0,
      cycleResetAt: (credits?.cycleResetAt ?? new Date()).toISOString(),
    };
  },

  /**
   * Atomically deduct credits. Drains `included` first, then `purchased`.
   * Uses conditional update to prevent race conditions.
   * Throws InsufficientCreditsError if balance is too low.
   */
  async deductCredits(orgId: string, amount: number, _reason?: string): Promise<void> {
    if (amount <= 0) return;
    const c = await orgs();
    if (!c) throw new Error('Database unavailable');

    // Read current balance to determine split between included/purchased
    const balance = await this.getBalance(orgId);
    if (balance.total < amount) {
      throw new InsufficientCreditsError(amount, balance.total);
    }

    const deductFromIncluded = Math.min(balance.included, amount);
    const deductFromPurchased = amount - deductFromIncluded;

    // Atomic conditional update — prevents race between read and write
    const result = await c.updateOne(
      {
        id: orgId,
        $expr: {
          $gte: [
            { $add: ['$phoneCredits.included', '$phoneCredits.purchased'] },
            amount,
          ],
        },
      },
      {
        $inc: {
          'phoneCredits.included': -deductFromIncluded,
          'phoneCredits.purchased': -deductFromPurchased,
          'phoneCredits.usedThisCycle': amount,
        },
      }
    );

    if (result.matchedCount === 0) {
      // Re-read to get accurate balance for error message
      const fresh = await this.getBalance(orgId);
      throw new InsufficientCreditsError(amount, fresh.total);
    }
  },

  /**
   * Refund credits (used to compensate for failed operations after credit deduction).
   */
  async refundCredits(orgId: string, amount: number): Promise<void> {
    if (amount <= 0) return;
    const c = await orgs();
    if (!c) return;
    // Refund to `included` first (same bucket it was likely taken from)
    await c.updateOne(
      { id: orgId },
      {
        $inc: {
          'phoneCredits.included': amount,
          'phoneCredits.usedThisCycle': -amount,
        },
      }
    );
  },

  /**
   * Add purchased credits from a Stripe payment.
   */
  async addPurchasedCredits(orgId: string, amount: number, _stripePaymentId: string): Promise<void> {
    if (amount <= 0) return;
    const c = await orgs();
    if (!c) return;
    await c.updateOne(
      { id: orgId },
      { $inc: { 'phoneCredits.purchased': amount } }
    );
  },

  /**
   * Reset included credits at the start of a new billing cycle.
   * Called by the invoice.paid Stripe webhook.
   */
  async resetIncludedCredits(orgId: string, amount: number, cycleResetAt: Date): Promise<void> {
    const c = await orgs();
    if (!c) return;
    await c.updateOne(
      { id: orgId },
      {
        $set: {
          'phoneCredits.included': amount,
          'phoneCredits.usedThisCycle': 0,
          'phoneCredits.cycleResetAt': cycleResetAt,
        },
      }
    );
  },

  /**
   * Charge 150 credits per active phone number for the month.
   * Called by invoice.paid after resetIncludedCredits.
   * Suspends numbers that would cause negative balance.
   */
  async chargeForActivePhoneNumbers(orgId: string): Promise<void> {
    const { getCollection: gc } = await import('../db');
    const pnCol = await gc('phone_numbers');
    if (!pnCol) return;

    const activeNumbers = await pnCol.find({ orgId, status: 'active' }).toArray();
    if (activeNumbers.length === 0) return;

    for (const pn of activeNumbers) {
      try {
        await this.deductCredits(orgId, pn.creditCostPerMonth ?? 150, `phone_number_renewal:${pn.id}`);
      } catch (err) {
        if (err instanceof InsufficientCreditsError) {
          // Suspend number — org ran out of credits
          await pnCol.updateOne({ id: pn.id }, { $set: { status: 'suspended_non_payment', updatedAt: new Date() } });
        }
      }
    }
  },
};
