import { Router } from 'express';
import { z } from 'zod';
import { phoneNumberStore } from '../../stores/phoneNumberStore';
import { creditStore } from '../../stores/creditStore';
import {
  createSubaccount,
  createMessagingService,
  searchAvailableNumbers,
  purchasePhoneNumber,
  releasePhoneNumber as twilioReleasePhoneNumber,
  addNumberToMessagingService,
  removeNumberFromMessagingService,
  subaccountClient,
  parentClient,
} from '../../services/sms/twilioService';
import { requirePhoneNumberQuota, requirePhoneScoped } from '../../middleware/smsGate';
import { requireAdminApiKey, requirePermission } from '../../middleware/permissions';
import { phoneNumberPurchaseRateLimiter } from '../../lib/redisRateLimiter';
import { getCollection } from '../../db';
import { encrypt, decrypt } from '../../lib/encryption';
import { invalidateCachedCreds, invalidateCachedPhoneLookup } from '../../lib/smsCache';
import { resolveOrgTier } from '../../lib/tierResolver';
import { hasFeature } from '../../config/rateLimits';
import { PHONE_NUMBER_MONTHLY_CREDITS } from '../../config/smsCosts';
import type { Organization } from '../../types/auth';
import type { PhoneNumber } from '../../types/phone';
import logger from '../../utils/logger';

const router = Router();

const E164_REGEX = /^\+[1-9]\d{6,14}$/;

function validateE164(num: string): boolean {
  return E164_REGEX.test(num);
}

/** Strip internal/provider fields before sending to API consumers */
function serializePhoneNumber(pn: any) {
  return {
    id: pn.id,
    number: pn.number,
    numberType: pn.numberType,
    friendlyName: pn.friendlyName ?? null,
    country: pn.country,
    capabilities: pn.capabilities,
    status: pn.status,
    allowList: pn.allowList ?? [],
    blockList: pn.blockList ?? [],
    creditCostPerMonth: pn.creditCostPerMonth,
    autoReply: pn.autoReply ?? null,
    createdAt: pn.createdAt,
    updatedAt: pn.updatedAt,
  };
}

// ─── GET /phone-numbers/available ────────────────────────────────

router.get('/available', requirePermission('phoneNumbers:read'), async (req: any, res) => {
  try {
    const orgId: string = req.orgId;
    const tier = await resolveOrgTier(orgId);
    if (!hasFeature(tier, 'smsMessaging')) {
      return res.status(403).json({ error: 'plan_upgrade_required', feature: 'smsMessaging' });
    }

    const orgs = await getCollection<Organization>('organizations');
    const org = orgs ? await orgs.findOne({ id: orgId }) : null;

    // Use subaccount client if provisioned, otherwise fall back to parent account for discovery
    let client;
    if (org?.twilioSubaccountSid && org?.twilioSubaccountAuthToken) {
      const authToken = decrypt(org.twilioSubaccountAuthToken);
      client = subaccountClient(org.twilioSubaccountSid, authToken);
    } else {
      client = parentClient();
    }

    const country = (req.query.country as string) || 'US';
    const type = (req.query.type as 'Local' | 'TollFree') || 'TollFree';
    const results = await searchAvailableNumbers({
      client,
      country,
      areaCode: req.query.area_code as string | undefined,
      type,
      smsEnabled: req.query.sms_enabled !== 'false',
      mmsEnabled: req.query.mms_enabled === 'true' ? true : undefined,
      contains: req.query.contains as string | undefined,
      inRegion: req.query.in_region as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 20,
    });

    return res.json({ data: results });
  } catch (err: any) {
    logger.error('Failed to search available numbers', { error: err });
    return res.status(500).json({ error: err.message || 'Failed to search available numbers' });
  }
});

// ─── POST /phone-numbers ──────────────────────────────────────────

const PurchaseSchema = z.object({
  country: z.string().length(2).default('US'),
  phone_number: z.string().optional(),
  area_code: z.string().optional(),
  type: z.enum(['local', 'tollfree']).default('tollfree'),
  friendly_name: z.string().max(100).optional(),
});

router.post(
  '/',
  requireAdminApiKey,
  requirePermission('phoneNumbers:write'),
  phoneNumberPurchaseRateLimiter as any,
  requirePhoneNumberQuota,
  async (req: any, res) => {
    const orgId: string = req.orgId;

    // Feature gate
    const tier = await resolveOrgTier(orgId);
    if (!hasFeature(tier, 'smsMessaging')) {
      return res.status(403).json({ error: 'plan_upgrade_required', feature: 'smsMessaging' });
    }

    const parsed = PurchaseSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    }
    const { country, phone_number, area_code, type, friendly_name } = parsed.data;

    // Block US local without A2P
    const orgs = await getCollection<Organization>('organizations');
    if (!orgs) return res.status(500).json({ error: 'Database error' });
    const org = await orgs.findOne({ id: orgId });
    if (country === 'US' && type === 'local' && org?.a2pStatus !== 'campaign_approved') {
      return res.status(403).json({
        error: 'us_local_a2p_required',
        message: 'US local numbers require A2P 10DLC campaign registration. Use toll-free numbers for now.',
        a2p_status: org?.a2pStatus ?? 'none',
      });
    }

    // 30-day cooldown check
    const hasCooldown = await phoneNumberStore.hasRecentRelease(orgId);
    if (hasCooldown) {
      return res.status(429).json({
        error: 'release_cooldown_active',
        message: 'You must wait 30 days after releasing a phone number before purchasing a new one.',
      });
    }

    // Pre-flight credit check (prorate for remaining days in cycle)
    const balance = await creditStore.getBalance(orgId);
    const cycleResetAt = new Date(balance.cycleResetAt);
    const now = new Date();
    const daysRemaining = Math.ceil((cycleResetAt.getTime() - now.getTime()) / 86400000);
    const proratedCost = Math.max(1, Math.ceil((daysRemaining / 30) * PHONE_NUMBER_MONTHLY_CREDITS));

    if (balance.total < proratedCost) {
      return res.status(402).json({
        error: 'insufficient_phone_credits',
        message: `Purchasing a phone number costs ${proratedCost} credits (prorated for ${daysRemaining} days remaining). Your balance is ${balance.total}.`,
        required: proratedCost,
        balance: balance.total,
        buy_url: '/dashboard/billing',
      });
    }

    // Provision Twilio subaccount + messaging service if first number
    let subaccountSid = org?.twilioSubaccountSid;
    let subaccountAuthToken: string | undefined;
    let messagingServiceSid = org?.twilioMessagingServiceSid;

    if (!subaccountSid) {
      try {
        const newSub = await createSubaccount(`Commune Org ${orgId}`);
        subaccountSid = newSub.sid;
        subaccountAuthToken = newSub.authToken;
        const encAuthToken = encrypt(newSub.authToken);
        await orgs.updateOne(
          { id: orgId },
          { $set: { twilioSubaccountSid: subaccountSid, twilioSubaccountAuthToken: encAuthToken } }
        );
        // Bust stale credential cache — new subaccount credentials just written
        invalidateCachedCreds(orgId).catch(() => {});
      } catch (err: any) {
        // Trial accounts can't create subaccounts — fall back to parent account
        const isTrial = err.message?.includes('trial') || err.code === 20008;
        if (isTrial) {
          logger.warn('Twilio trial account detected — using parent account (upgrade to unlock subaccounts)', { orgId });
          subaccountSid = process.env.TWILIO_ACCOUNT_SID!;
          subaccountAuthToken = process.env.TWILIO_AUTH_TOKEN!;
          const encAuthToken = encrypt(subaccountAuthToken);
          await orgs.updateOne(
            { id: orgId },
            { $set: { twilioSubaccountSid: subaccountSid, twilioSubaccountAuthToken: encAuthToken } }
          );
          invalidateCachedCreds(orgId).catch(() => {});
        } else {
          logger.error('Failed to create Twilio subaccount', { orgId, error: err });
          return res.status(502).json({ error: 'Failed to create Twilio subaccount', details: err.message });
        }
      }
    } else {
      // Decrypt existing auth token (already statically imported)
      subaccountAuthToken = decrypt(org!.twilioSubaccountAuthToken!);
    }

    const client = subaccountClient(subaccountSid, subaccountAuthToken!);

    if (!messagingServiceSid) {
      try {
        messagingServiceSid = await createMessagingService(client, `Commune Org ${orgId}`);
        await orgs.updateOne({ id: orgId }, { $set: { twilioMessagingServiceSid: messagingServiceSid } });
      } catch (err: any) {
        logger.error('Failed to create Messaging Service', { orgId, error: err });
        return res.status(502).json({ error: 'Failed to create Twilio Messaging Service', details: err.message });
      }
    }

    // Search available numbers if no specific number provided
    let targetNumber = phone_number;
    if (!targetNumber) {
      const available = await searchAvailableNumbers({
        client,
        country,
        areaCode: area_code,
        type: type === 'tollfree' ? 'TollFree' : 'Local',
        smsEnabled: true,
        limit: 1,
      });
      if (!available.length) {
        return res.status(404).json({ error: 'No available phone numbers matching your criteria' });
      }
      targetNumber = available[0].phoneNumber;
    }

    // Purchase the phone number
    let twilioResult: Awaited<ReturnType<typeof purchasePhoneNumber>>;
    try {
      twilioResult = await purchasePhoneNumber(client, targetNumber);
    } catch (err: any) {
      logger.error('Failed to purchase phone number', { orgId, number: targetNumber, error: err });
      return res.status(502).json({ error: 'Failed to purchase phone number', details: err.message });
    }

    // Add to Messaging Service
    try {
      await addNumberToMessagingService(client, messagingServiceSid, twilioResult.twilioSid);
    } catch (err: any) {
      // Rollback: release the number we just bought
      await twilioReleasePhoneNumber(client, twilioResult.twilioSid).catch(() => {});
      logger.error('Failed to add number to Messaging Service', { orgId, error: err });
      return res.status(502).json({ error: 'Failed to configure phone number', details: err.message });
    }

    // Atomic: deduct credits + store phone number in MongoDB
    const phoneNumberId = await phoneNumberStore.generateId();
    const phoneNumberDoc: PhoneNumber = {
      id: phoneNumberId,
      orgId,
      twilioSid: twilioResult.twilioSid,
      twilioSubaccountSid: subaccountSid,
      twilioMessagingServiceSid: messagingServiceSid,
      number: targetNumber,
      numberType: twilioResult.numberType,
      friendlyName: friendly_name,
      country,
      capabilities: twilioResult.capabilities,
      allowList: [],
      blockList: [],
      status: 'active',
      creditCostPerMonth: PHONE_NUMBER_MONTHLY_CREDITS,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    try {
      await creditStore.deductCredits(orgId, proratedCost, `phone_number_purchase:${phoneNumberId}`);
      await phoneNumberStore.upsertPhoneNumber(phoneNumberDoc);
    } catch (err: any) {
      // Rollback: remove from messaging service + release from Twilio
      await removeNumberFromMessagingService(client, messagingServiceSid, twilioResult.twilioSid).catch(() => {});
      await twilioReleasePhoneNumber(client, twilioResult.twilioSid).catch(() => {});
      logger.error('Failed to deduct credits / store phone number', { orgId, error: err });
      return res.status(402).json({ error: err.message || 'Insufficient credits' });
    }

    return res.status(201).json({ data: serializePhoneNumber(phoneNumberDoc) });
  }
);

// ─── GET /phone-numbers ───────────────────────────────────────────

router.get('/', requirePermission('phoneNumbers:read'), async (req: any, res) => {
  try {
    const numbers = await phoneNumberStore.listPhoneNumbers(req.orgId);
    return res.json({ data: numbers.map(serializePhoneNumber) });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /phone-numbers/:id ───────────────────────────────────────

router.get('/:id', requirePermission('phoneNumbers:read'), requirePhoneScoped, async (req: any, res) => {
  try {
    const pn = await phoneNumberStore.getPhoneNumber(req.params.id, req.orgId);
    if (!pn) return res.status(404).json({ error: 'Phone number not found' });
    return res.json({ data: serializePhoneNumber(pn) });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /phone-numbers/:id ────────────────────────────────────

router.delete('/:id', requireAdminApiKey, requirePermission('phoneNumbers:write'), async (req: any, res) => {
  try {
    const orgId: string = req.orgId;
    const pn = await phoneNumberStore.getPhoneNumber(req.params.id, orgId);
    if (!pn) return res.status(404).json({ error: 'Phone number not found' });
    if (pn.status === 'released') return res.status(409).json({ error: 'Phone number already released' });

    // Release from Twilio
    const orgs = await getCollection<Organization>('organizations');
    const org = orgs ? await orgs.findOne({ id: orgId }) : null;
    if (org?.twilioSubaccountSid && org?.twilioSubaccountAuthToken) {
      const authToken = decrypt(org.twilioSubaccountAuthToken);
      const client = subaccountClient(org.twilioSubaccountSid, authToken);
      await removeNumberFromMessagingService(client, pn.twilioMessagingServiceSid, pn.twilioSid).catch(() => {});
      await twilioReleasePhoneNumber(client, pn.twilioSid).catch(() => {});
    }

    await phoneNumberStore.releasePhoneNumber(pn.id, orgId);
    // Bust E164 cache so inbound SMS to this number stops routing to this org immediately
    invalidateCachedPhoneLookup(pn.number).catch(() => {});
    return res.json({ data: { id: pn.id, status: 'released', message: 'Phone number released. No credit refund. History retained.' } });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── PUT /phone-numbers/:id/allow-list ───────────────────────────

router.put('/:id/allow-list', requireAdminApiKey, requirePermission('phoneNumbers:write'), async (req: any, res) => {
  try {
    const { numbers } = req.body;
    if (!Array.isArray(numbers)) return res.status(400).json({ error: 'numbers must be an array' });
    const invalid = numbers.filter((n: string) => !validateE164(n));
    if (invalid.length) return res.status(400).json({ error: 'Invalid E.164 numbers', invalid });
    const updated = await phoneNumberStore.updateAllowList(req.params.id, req.orgId, numbers);
    if (!updated) return res.status(404).json({ error: 'Phone number not found' });
    // Bust E164 cache so inbound SMS re-fetches the full document with updated allow list
    invalidateCachedPhoneLookup(updated.number).catch(() => {});
    return res.json({ data: serializePhoneNumber(updated) });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── PUT /phone-numbers/:id/block-list ───────────────────────────

router.put('/:id/block-list', requireAdminApiKey, requirePermission('phoneNumbers:write'), async (req: any, res) => {
  try {
    const { numbers } = req.body;
    if (!Array.isArray(numbers)) return res.status(400).json({ error: 'numbers must be an array' });
    const invalid = numbers.filter((n: string) => !validateE164(n));
    if (invalid.length) return res.status(400).json({ error: 'Invalid E.164 numbers', invalid });
    const updated = await phoneNumberStore.updateBlockList(req.params.id, req.orgId, numbers);
    if (!updated) return res.status(404).json({ error: 'Phone number not found' });
    // Bust E164 cache so inbound SMS re-fetches the full document with updated block list
    invalidateCachedPhoneLookup(updated.number).catch(() => {});
    return res.json({ data: serializePhoneNumber(updated) });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /phone-numbers/:id ────────────────────────────────────

const UpdateSchema = z.object({
  friendly_name: z.string().max(100).optional(),
  auto_reply: z.object({
    enabled: z.boolean(),
    body: z.string().max(1600),
  }).optional(),
  webhook: z.object({
    endpoint: z.string().url().optional(),
    secret: z.string().optional(),
    events: z.array(z.string()).optional(),
  }).optional(),
});

router.patch('/:id', requirePermission('phoneNumbers:write'), async (req: any, res) => {
  try {
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const pn = await phoneNumberStore.getPhoneNumber(req.params.id, req.orgId);
    if (!pn) return res.status(404).json({ error: 'Phone number not found' });

    const updates: any = {};
    if (parsed.data.friendly_name !== undefined) updates.friendlyName = parsed.data.friendly_name;
    if (parsed.data.auto_reply !== undefined) updates.autoReply = parsed.data.auto_reply;
    if (parsed.data.webhook !== undefined) updates.webhook = parsed.data.webhook;

    const updated = await phoneNumberStore.update(req.params.id, req.orgId, updates);
    if (!updated) return res.status(404).json({ error: 'Phone number not found' });
    // Bust E164 cache so inbound SMS picks up any webhook/autoReply changes immediately
    invalidateCachedPhoneLookup(updated.number).catch(() => {});
    return res.json({ data: serializePhoneNumber(updated) });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
