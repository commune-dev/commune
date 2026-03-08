import { Router } from 'express';
import { z } from 'zod';
import * as callStore from '../../stores/callStore';
import * as voiceAgentStore from '../../stores/voiceAgentStore';
import * as toolStore from '../../stores/toolStore';
import { phoneNumberStore } from '../../stores/phoneNumberStore';
import { subaccountClient } from '../../services/sms/twilioService';
import { resolveOrgTier } from '../../lib/tierResolver';
import { hasFeature, getOrgTierLimits } from '../../config/rateLimits';
import logger from '../../utils/logger';
import type { Organization } from '../../types/auth';
import { getCollection } from '../../db';

const router = Router();

const WEBHOOK_BASE_URL = process.env.TWILIO_WEBHOOK_BASE_URL ?? 'https://api.commune.email';
const BRIDGE_HOST = process.env.VOICE_BRIDGE_HOST ?? process.env.TWILIO_WEBHOOK_BASE_URL?.replace('https://', '') ?? 'api.commune.email';

// Credit costs (in credits per minute)
const VOICE_CREDITS_PER_MIN: Record<string, number> = {
  US_OUTBOUND: 50,
  US_INBOUND: 35,
  GB_OUTBOUND: 65,
  DEFAULT_OUTBOUND: 60,
};

function E164_REGEX(num: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(num);
}

const InitiateCallSchema = z.object({
  to: z.string().refine(E164_REGEX, 'Must be a valid E.164 phone number (e.g. +14155551234)'),
  phoneNumberId: z.string(),
  maxDurationSeconds: z.number().min(10).max(3600).optional(),
  machineDetection: z.enum(['Enable', 'DetectMessageEnd']).optional(),
});

// ─── GET /v1/calls ────────────────────────────────────────────────

router.get('/', async (req: any, res) => {
  try {
    const orgId: string = req.orgId;
    const tier = await resolveOrgTier(orgId);
    if (!hasFeature(tier, 'voiceCalling')) {
      return res.status(403).json({ error: 'Voice calling requires agent_pro plan or higher' });
    }

    const phoneNumberId = req.query.phoneNumberId as string | undefined;
    const status = req.query.status as string | undefined;
    const limit = Math.min(parseInt(req.query.limit ?? '20', 10), 100);
    const skip = parseInt(req.query.skip ?? '0', 10);

    const calls = await callStore.listCalls(orgId, { phoneNumberId, status: status as any, limit, skip });
    return res.json({ data: calls.map(serializeCall) });
  } catch (err) {
    logger.error('GET /v1/calls error', { err });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /v1/calls/:id ────────────────────────────────────────────

router.get('/:id', async (req: any, res) => {
  try {
    const orgId: string = req.orgId;
    const call = await callStore.getCallById(orgId, req.params.id);
    if (!call) return res.status(404).json({ error: 'Call not found' });
    return res.json({ data: serializeCall(call) });
  } catch (err) {
    logger.error('GET /v1/calls/:id error', { err });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /v1/calls ───────────────────────────────────────────────

router.post('/', async (req: any, res) => {
  try {
    const orgId: string = req.orgId;

    const tier = await resolveOrgTier(orgId);
    if (!hasFeature(tier, 'voiceCalling')) {
      return res.status(403).json({ error: 'Voice calling requires agent_pro plan or higher' });
    }

    const body = InitiateCallSchema.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid request' });
    }

    const { to, phoneNumberId, maxDurationSeconds, machineDetection } = body.data;

    // Load phone number
    const phoneNumber = await phoneNumberStore.getPhoneNumber(phoneNumberId, orgId);
    if (!phoneNumber || phoneNumber.status !== 'active') {
      return res.status(404).json({ error: 'Phone number not found or inactive' });
    }
    if (!phoneNumber.capabilities.voice) {
      return res.status(400).json({ error: 'This phone number does not have voice capability' });
    }

    // Load voice agent config for this phone number
    const voiceAgent = await voiceAgentStore.getVoiceAgent(orgId, phoneNumberId);
    if (!voiceAgent) {
      return res.status(400).json({
        error: 'No voice agent configured for this phone number. Set one up via PUT /v1/phone-numbers/:id/voice-agent',
      });
    }

    // Compute credit cost
    const durationSeconds = maxDurationSeconds ?? voiceAgent.maxCallDurationSeconds;
    const isUS = phoneNumber.country === 'US' || to.startsWith('+1');
    const creditsPerMin = isUS ? VOICE_CREDITS_PER_MIN.US_OUTBOUND : VOICE_CREDITS_PER_MIN.DEFAULT_OUTBOUND;
    const creditsRequired = Math.ceil((durationSeconds / 60) * creditsPerMin);

    // Atomic credit reservation — prevents race conditions
    const reserved = await callStore.reserveCredits(orgId, creditsRequired);
    if (!reserved) {
      return res.status(402).json({ error: 'Insufficient credits for this call duration' });
    }

    // Concurrent call limit
    const limits = getOrgTierLimits(tier);
    if (limits.maxConcurrentCalls !== Infinity) {
      const activeCalls = await callStore.listCalls(orgId, { status: 'in-progress' as any });
      if (activeCalls.length >= limits.maxConcurrentCalls) {
        // Release reserved credits
        await callStore.releaseCredits(orgId, creditsRequired);
        return res.status(429).json({
          error: `Maximum ${limits.maxConcurrentCalls} concurrent calls reached for your plan`,
        });
      }
    }

    // Get org Twilio subaccount credentials
    const orgCol = await getCollection<Organization>('organizations');
    const org = await orgCol?.findOne({ id: orgId });
    if (!org?.twilioSubaccountSid || !org?.twilioSubaccountAuthToken) {
      await callStore.releaseCredits(orgId, creditsRequired);
      return res.status(500).json({ error: 'Organization Twilio account not configured' });
    }

    // Create call record BEFORE dialing (need callId for inline TwiML)
    // callSid is a placeholder — will be replaced when Twilio returns the real SID
    const call = await callStore.createCall({
      orgId,
      phoneNumberId,
      voiceAgentId: voiceAgent.id,
      callSid: 'pending',  // updated after Twilio call creation
      direction: 'outbound',
      to,
      from: phoneNumber.number,
      creditsReserved: creditsRequired,
    });

    // Build inline TwiML — embeds callId so bridge can look it up
    // Use wss:// for TLS — required by Twilio for production
    const streamUrl = `wss://${BRIDGE_HOST}/ws/voice/${call.id}?nonce=${call.wsNonce}`;
    const twiml = [
      '<Response>',
      '  <Connect>',
      `    <Stream url="${streamUrl}">`,
      `      <Parameter name="callId" value="${call.id}"/>`,
      `      <Parameter name="nonce" value="${call.wsNonce}"/>`,
      '    </Stream>',
      '  </Connect>',
      '</Response>',
    ].join('');

    // Dial with Twilio
    const twilioCall = await subaccountClient(
      org.twilioSubaccountSid,
      org.twilioSubaccountAuthToken
    ).calls.create({
      to,
      from: phoneNumber.number,
      twiml,  // inline — eliminates webhook roundtrip
      statusCallback: `${WEBHOOK_BASE_URL}/api/webhooks/twilio/voice/status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
      timeLimit: durationSeconds,
      ...(machineDetection ? {
        machineDetection,
        asyncAmd: 'true',
        asyncAmdStatusCallback: `${WEBHOOK_BASE_URL}/api/webhooks/twilio/voice/amd/${call.id}`,
        asyncAmdStatusCallbackMethod: 'POST',
      } : {}),
    });

    // Patch the pending callSid with the real Twilio SID
    const col = await getCollection<Record<string, unknown>>('calls');
    await col?.updateOne({ id: call.id }, { $set: { callSid: twilioCall.sid, status: 'ringing', updatedAt: new Date() } });

    logger.info('Outbound call initiated', {
      callId: call.id,
      callSid: twilioCall.sid,
      to,
      from: phoneNumber.number,
      orgId,
    });

    return res.status(201).json({
      data: {
        id: call.id,
        callSid: twilioCall.sid,
        status: 'ringing',
        to,
        from: phoneNumber.number,
        direction: 'outbound',
        creditsReserved: creditsRequired,
        createdAt: call.createdAt,
      },
    });
  } catch (err) {
    logger.error('POST /v1/calls error', { err });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /v1/calls/:id/hangup ────────────────────────────────────

router.post('/:id/hangup', async (req: any, res) => {
  try {
    const orgId: string = req.orgId;
    const call = await callStore.getCallById(orgId, req.params.id);
    if (!call) return res.status(404).json({ error: 'Call not found' });

    if (['completed', 'failed', 'busy', 'no-answer'].includes(call.status)) {
      return res.status(400).json({ error: 'Call has already ended' });
    }

    // Get org subaccount credentials
    const orgCol = await getCollection<Organization>('organizations');
    const org = await orgCol?.findOne({ id: orgId });
    if (!org?.twilioSubaccountSid || !org?.twilioSubaccountAuthToken) {
      return res.status(500).json({ error: 'Organization Twilio account not configured' });
    }

    await subaccountClient(org.twilioSubaccountSid, org.twilioSubaccountAuthToken)
      .calls(call.callSid)
      .update({ status: 'completed' });

    return res.json({ data: { id: call.id, status: 'completed' } });
  } catch (err) {
    logger.error('POST /v1/calls/:id/hangup error', { err });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Serializer ───────────────────────────────────────────────────

function serializeCall(call: any) {
  return {
    id: call.id,
    phoneNumberId: call.phoneNumberId,
    voiceAgentId: call.voiceAgentId,
    callSid: call.callSid,
    direction: call.direction,
    to: call.to,
    from: call.from,
    status: call.status,
    startedAt: call.startedAt ?? null,
    answeredAt: call.answeredAt ?? null,
    endedAt: call.endedAt ?? null,
    durationSeconds: call.durationSeconds ?? null,
    transcript: call.transcript ?? [],
    toolCallLog: call.toolCallLog ?? [],
    creditsReserved: call.creditsReserved,
    creditsCharged: call.creditsCharged ?? null,
    createdAt: call.createdAt,
    updatedAt: call.updatedAt,
  };
}

export default router;
