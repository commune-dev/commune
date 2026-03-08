import { Router } from 'express';
import { z } from 'zod';
import * as voiceAgentStore from '../../stores/voiceAgentStore';
import * as toolStore from '../../stores/toolStore';
import { phoneNumberStore } from '../../stores/phoneNumberStore';
import { resolveOrgTier } from '../../lib/tierResolver';
import { hasFeature } from '../../config/rateLimits';
import logger from '../../utils/logger';

const router = Router();

const VOICE_NAME_VALUES = ['alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'marin', 'sage', 'shimmer', 'verse'] as const;

const SetVoiceAgentSchema = z.object({
  systemPrompt: z.string().min(1).max(16000),
  voice: z.enum(VOICE_NAME_VALUES).default('marin'),
  firstMessage: z.string().max(500).optional(),
  toolIds: z.array(z.string()).max(20).default([]),
  maxCallDurationSeconds: z.number().min(10).max(3600).default(600),
  idleTimeoutMs: z.number().min(1000).max(60000).default(10000),
  recordingEnabled: z.boolean().default(false),
});

// ─── GET /phone-numbers/:phoneNumberId/voice-agent ─────────────────

router.get('/:phoneNumberId/voice-agent', async (req: any, res) => {
  try {
    const orgId: string = req.orgId;
    const { phoneNumberId } = req.params;

    const tier = await resolveOrgTier(orgId);
    if (!hasFeature(tier, 'voiceCalling')) {
      return res.status(403).json({ error: 'Voice calling requires agent_pro plan or higher' });
    }

    const phoneNumber = await phoneNumberStore.getPhoneNumber(phoneNumberId, orgId);
    if (!phoneNumber) return res.status(404).json({ error: 'Phone number not found' });

    const agent = await voiceAgentStore.getVoiceAgent(orgId, phoneNumberId);
    if (!agent) return res.status(404).json({ error: 'No voice agent configured for this phone number' });

    // Include tool metadata (names, not secrets)
    const tools = await toolStore.getToolsByIds(orgId, agent.toolIds);

    return res.json({
      data: {
        ...agent,
        tools: tools.map(t => ({ id: t.id, name: t.name, description: t.description })),
      },
    });
  } catch (err) {
    logger.error('GET voice-agent error', { err });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PUT /phone-numbers/:phoneNumberId/voice-agent ─────────────────

router.put('/:phoneNumberId/voice-agent', async (req: any, res) => {
  try {
    const orgId: string = req.orgId;
    const { phoneNumberId } = req.params;

    const tier = await resolveOrgTier(orgId);
    if (!hasFeature(tier, 'voiceCalling')) {
      return res.status(403).json({ error: 'Voice calling requires agent_pro plan or higher' });
    }

    const body = SetVoiceAgentSchema.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid request' });
    }

    const phoneNumber = await phoneNumberStore.getPhoneNumber(phoneNumberId, orgId);
    if (!phoneNumber) return res.status(404).json({ error: 'Phone number not found' });

    if (!phoneNumber.capabilities.voice) {
      return res.status(400).json({
        error: 'This phone number does not have voice capability. Purchase a voice-capable number.',
      });
    }

    // Validate all toolIds belong to this org
    if (body.data.toolIds.length > 0) {
      const tools = await toolStore.getToolsByIds(orgId, body.data.toolIds);
      if (tools.length !== body.data.toolIds.length) {
        return res.status(400).json({ error: 'One or more tool IDs not found or do not belong to this organization' });
      }
    }

    const agent = await voiceAgentStore.upsertVoiceAgent(orgId, phoneNumberId, body.data);

    return res.json({ data: agent });
  } catch (err) {
    logger.error('PUT voice-agent error', { err });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /phone-numbers/:phoneNumberId/voice-agent ──────────────

router.delete('/:phoneNumberId/voice-agent', async (req: any, res) => {
  try {
    const orgId: string = req.orgId;
    const { phoneNumberId } = req.params;

    const deleted = await voiceAgentStore.deleteVoiceAgent(orgId, phoneNumberId);
    if (!deleted) return res.status(404).json({ error: 'No voice agent configured for this phone number' });

    return res.status(204).end();
  } catch (err) {
    logger.error('DELETE voice-agent error', { err });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
