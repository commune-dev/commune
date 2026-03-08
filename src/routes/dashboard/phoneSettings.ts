/**
 * Dashboard-only phone settings API.
 * These settings are configured by humans and enforce anti-spam limits on agents.
 * NOT exposed through the v1 agent API.
 */

import { Router } from 'express';
import { z } from 'zod';
import { getCollection } from '../../db';
import { phoneNumberStore } from '../../stores/phoneNumberStore';
import { smsUsageStore } from '../../stores/smsUsageStore';
import { creditStore } from '../../stores/creditStore';
import { resolveOrgTier } from '../../lib/tierResolver';
import { getOrgTierLimits } from '../../config/rateLimits';
import type { Organization } from '../../types/auth';
import logger from '../../utils/logger';

const router = Router();

// ─── GET /phone-settings ─────────────────────────────────────────
// Returns current settings, tier defaults, and live usage stats.

router.get('/phone-settings', async (req: any, res) => {
  try {
    const orgId: string = req.orgId;
    const orgs = await getCollection<Organization>('organizations');
    if (!orgs) return res.status(500).json({ error: 'Database unavailable' });

    const org = await orgs.findOne({ id: orgId });
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    const tier = await resolveOrgTier(orgId);
    const tierLimits = getOrgTierLimits(tier);

    // Live usage
    const activePhoneNumbers = await phoneNumberStore.listPhoneNumbers(orgId);
    const creditBalance = await creditStore.getBalance(orgId);
    const usageHistory = await smsUsageStore.getDailyTotals(orgId, 7);

    // Current effective limits (org override or tier default)
    const settings = org.phoneSettings ?? {};
    const effectiveLimits = {
      maxPhoneNumbers:       settings.maxPhoneNumbers       ?? tierLimits.maxPhoneNumbers,
      maxSmsPerDayPerNumber: settings.maxSmsPerDayPerNumber ?? 500,
      maxSmsPerDayTotal:     settings.maxSmsPerDayTotal     ?? 2000,
      maxSmsPerMonth:        settings.maxSmsPerMonth        ?? 20000,
    };

    return res.json({
      data: {
        // Current settings (null = using tier default)
        settings: {
          maxPhoneNumbers:       settings.maxPhoneNumbers        ?? null,
          maxSmsPerDayPerNumber: settings.maxSmsPerDayPerNumber  ?? null,
          maxSmsPerDayTotal:     settings.maxSmsPerDayTotal      ?? null,
          maxSmsPerMonth:        settings.maxSmsPerMonth         ?? null,
          requireHumanApprovalAbove: settings.requireHumanApprovalAbove ?? null,
        },
        // Effective limits (applied values)
        effective: effectiveLimits,
        // Tier defaults (for display in dashboard)
        tier_defaults: {
          maxPhoneNumbers: tierLimits.maxPhoneNumbers,
          maxSmsPerDayPerNumber: 500,
          maxSmsPerDayTotal: 2000,
          maxSmsPerMonth: 20000,
        },
        // Live usage
        usage: {
          active_phone_numbers: activePhoneNumbers.length,
          credits: creditBalance,
          daily_sends_7d: usageHistory,
        },
      },
    });
  } catch (err: any) {
    logger.error('Failed to get phone settings', { error: err });
    return res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /phone-settings ────────────────────────────────────────
// Update org-level phone limits (dashboard only).

const PhoneSettingsSchema = z.object({
  maxPhoneNumbers:           z.number().int().min(0).max(1000).nullable().optional(),
  maxSmsPerDayPerNumber:     z.number().int().min(1).max(100000).nullable().optional(),
  maxSmsPerDayTotal:         z.number().int().min(1).max(1000000).nullable().optional(),
  maxSmsPerMonth:            z.number().int().min(1).max(10000000).nullable().optional(),
  requireHumanApprovalAbove: z.number().int().min(1).nullable().optional(),
});

router.patch('/phone-settings', async (req: any, res) => {
  const parsed = PhoneSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }

  try {
    const orgId: string = req.orgId;
    const orgs = await getCollection<Organization>('organizations');
    if (!orgs) return res.status(500).json({ error: 'Database unavailable' });

    // Build the update — null values remove the override (revert to tier default)
    const updateFields: Record<string, any> = {};
    const unsetFields: Record<string, string> = {};

    for (const [key, value] of Object.entries(parsed.data)) {
      if (value === null) {
        unsetFields[`phoneSettings.${key}`] = '';
      } else if (value !== undefined) {
        updateFields[`phoneSettings.${key}`] = value;
      }
    }

    const update: Record<string, any> = { $set: { updatedAt: new Date().toISOString() } };
    if (Object.keys(updateFields).length) update.$set = { ...update.$set, ...updateFields };
    if (Object.keys(unsetFields).length) update.$unset = unsetFields;

    await orgs.updateOne({ id: orgId }, update);

    logger.info('Phone settings updated', { orgId, changes: parsed.data });

    // Re-fetch to return updated state
    const updated = await orgs.findOne({ id: orgId }, { projection: { phoneSettings: 1 } });
    return res.json({ data: { settings: updated?.phoneSettings ?? {}, updated: true } });
  } catch (err: any) {
    logger.error('Failed to update phone settings', { error: err });
    return res.status(500).json({ error: err.message });
  }
});

export default router;
