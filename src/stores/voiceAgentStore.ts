import { ObjectId } from 'mongodb';
import { randomUUID } from 'crypto';
import { getCollection } from '../db';
import type { VoiceAgent, SetVoiceAgentParams } from '../types/voice';

const COLLECTION = 'voice_agents';

function serialize(doc: Record<string, unknown>): VoiceAgent {
  const { _id, ...rest } = doc;
  return rest as unknown as VoiceAgent;
}

export async function upsertVoiceAgent(
  orgId: string,
  phoneNumberId: string,
  params: SetVoiceAgentParams
): Promise<VoiceAgent> {
  const col = await getCollection<Record<string, unknown>>(COLLECTION);
  if (!col) throw new Error('DB unavailable');

  const now = new Date();
  const update: Record<string, unknown> = {
    orgId,
    phoneNumberId,
    systemPrompt: params.systemPrompt,
    voice: params.voice ?? 'marin',
    firstMessage: params.firstMessage ?? null,
    toolIds: params.toolIds ?? [],
    turnDetection: {
      type: 'server_vad',
      threshold: 0.5,
      prefixPaddingMs: 300,
      silenceDurationMs: 500,
      idleTimeoutMs: params.idleTimeoutMs ?? 10000,
      createResponse: true,
      interruptResponse: true,
    },
    maxCallDurationSeconds: params.maxCallDurationSeconds ?? 600,
    recordingEnabled: params.recordingEnabled ?? false,
    updatedAt: now,
  };

  const result = await col.findOneAndUpdate(
    { orgId, phoneNumberId },
    {
      $set: update,
      $setOnInsert: {
        _id: new ObjectId(),
        id: `va_${randomUUID().replace(/-/g, '')}`,
        createdAt: now,
      },
    },
    { upsert: true, returnDocument: 'after' }
  );

  return serialize(result!);
}

export async function getVoiceAgent(orgId: string, phoneNumberId: string): Promise<VoiceAgent | null> {
  const col = await getCollection<Record<string, unknown>>(COLLECTION);
  if (!col) return null;
  const doc = await col.findOne({ orgId, phoneNumberId });
  return doc ? serialize(doc) : null;
}

export async function getVoiceAgentById(orgId: string, id: string): Promise<VoiceAgent | null> {
  const col = await getCollection<Record<string, unknown>>(COLLECTION);
  if (!col) return null;
  const doc = await col.findOne({ orgId, id });
  return doc ? serialize(doc) : null;
}

export async function deleteVoiceAgent(orgId: string, phoneNumberId: string): Promise<boolean> {
  const col = await getCollection<Record<string, unknown>>(COLLECTION);
  if (!col) return false;
  const result = await col.deleteOne({ orgId, phoneNumberId });
  return result.deletedCount > 0;
}
