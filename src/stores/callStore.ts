import { ObjectId } from 'mongodb';
import { randomUUID } from 'crypto';
import { getCollection } from '../db';
import type { Call, VoiceCallStatus, TranscriptEntry, ToolCallLogEntry } from '../types/voice';

const COLLECTION = 'calls';

function serialize(doc: Record<string, unknown>): Call {
  const { _id, ...rest } = doc;
  return rest as unknown as Call;
}

export async function createCall(
  data: Pick<Call, 'orgId' | 'phoneNumberId' | 'voiceAgentId' | 'callSid' | 'direction' | 'to' | 'from' | 'creditsReserved'>
): Promise<Call> {
  const col = await getCollection<Record<string, unknown>>(COLLECTION);
  if (!col) throw new Error('DB unavailable');

  const now = new Date();
  const wsNonce = randomUUID().replace(/-/g, '');
  const doc = {
    _id: new ObjectId(),
    id: `call_${randomUUID().replace(/-/g, '')}`,
    ...data,
    wsNonce,
    wsNonceUsed: false,
    status: 'initiating' as VoiceCallStatus,
    transcript: [],
    toolCallLog: [],
    createdAt: now,
    updatedAt: now,
  };

  await col.insertOne(doc);
  return serialize(doc);
}

export async function getCallById(orgId: string, id: string): Promise<Call | null> {
  const col = await getCollection<Record<string, unknown>>(COLLECTION);
  if (!col) return null;
  const doc = await col.findOne({ id, orgId });
  return doc ? serialize(doc) : null;
}

export async function getCallByCallSid(callSid: string): Promise<Call | null> {
  const col = await getCollection<Record<string, unknown>>(COLLECTION);
  if (!col) return null;
  const doc = await col.findOne({ callSid });
  return doc ? serialize(doc) : null;
}

export async function listCalls(
  orgId: string,
  opts: { phoneNumberId?: string; status?: VoiceCallStatus; limit?: number; skip?: number } = {}
): Promise<Call[]> {
  const col = await getCollection<Record<string, unknown>>(COLLECTION);
  if (!col) return [];

  const filter: Record<string, unknown> = { orgId };
  if (opts.phoneNumberId) filter.phoneNumberId = opts.phoneNumberId;
  if (opts.status) filter.status = opts.status;

  const docs = await col
    .find(filter)
    .sort({ createdAt: -1 })
    .skip(opts.skip ?? 0)
    .limit(opts.limit ?? 20)
    .toArray();

  return docs.map(serialize);
}

export async function updateCallStatus(
  callSid: string,
  status: VoiceCallStatus,
  extra?: Partial<Pick<Call, 'startedAt' | 'answeredAt' | 'endedAt' | 'durationSeconds' | 'streamSid'>>
): Promise<void> {
  const col = await getCollection<Record<string, unknown>>(COLLECTION);
  if (!col) return;
  await col.updateOne(
    { callSid },
    { $set: { status, updatedAt: new Date(), ...extra } }
  );
}

/**
 * Consume the WS nonce — returns true if valid and unused, false otherwise.
 * Atomic: marks used in the same op to prevent replay.
 */
export async function consumeWsNonce(callId: string, nonce: string): Promise<boolean> {
  const col = await getCollection<Record<string, unknown>>(COLLECTION);
  if (!col) return false;
  const result = await col.findOneAndUpdate(
    { id: callId, wsNonce: nonce, wsNonceUsed: false },
    { $set: { wsNonceUsed: true, updatedAt: new Date() } }
  );
  return !!result;
}

/**
 * Flush final transcript and tool call log to DB on call end.
 * Also settles credits and marks the call complete.
 */
export async function finalizeCall(
  callId: string,
  data: {
    status: VoiceCallStatus;
    endedAt: Date;
    durationSeconds: number;
    transcript: TranscriptEntry[];
    toolCallLog: ToolCallLogEntry[];
    creditsCharged: number;
  }
): Promise<void> {
  const col = await getCollection<Record<string, unknown>>(COLLECTION);
  if (!col) return;
  await col.updateOne(
    { id: callId },
    {
      $set: {
        status: data.status,
        endedAt: data.endedAt,
        durationSeconds: data.durationSeconds,
        transcript: data.transcript,
        toolCallLog: data.toolCallLog,
        creditsCharged: data.creditsCharged,
        updatedAt: new Date(),
      },
    }
  );
}

/**
 * Atomic credit reservation check.
 * Reserves credits if balance >= required. Returns false if insufficient.
 * Uses MongoDB findOneAndUpdate with $gte guard to prevent race conditions.
 * Credits live in organizations.phoneCredits (not a separate collection).
 */
export async function reserveCredits(
  orgId: string,
  requiredCredits: number
): Promise<boolean> {
  const col = await getCollection<Record<string, unknown>>('organizations');
  if (!col) return false;

  const result = await col.findOneAndUpdate(
    {
      id: orgId,
      $expr: {
        $gte: [
          { $add: ['$phoneCredits.included', '$phoneCredits.purchased'] },
          { $add: ['$phoneCredits.usedThisCycle', requiredCredits] },
        ],
      },
    },
    { $inc: { 'phoneCredits.usedThisCycle': requiredCredits } } as any,
    { returnDocument: 'after' }
  );

  return !!result;
}

export async function releaseCredits(orgId: string, credits: number): Promise<void> {
  const col = await getCollection<Record<string, unknown>>('organizations');
  if (!col) return;
  await col.updateOne({ id: orgId }, { $inc: { 'phoneCredits.usedThisCycle': -credits } } as any);
}

/**
 * Get call by internal ID without org scoping.
 * Only for use by the voice bridge AFTER nonce has been validated.
 */
export async function getCallByInternalId(id: string): Promise<Call | null> {
  const col = await getCollection<Record<string, unknown>>(COLLECTION);
  if (!col) return null;
  const doc = await col.findOne({ id });
  return doc ? serialize(doc) : null;
}

export async function ensureIndexes(): Promise<void> {
  const col = await getCollection<Record<string, unknown>>(COLLECTION);
  if (!col) return;

  await Promise.all([
    col.createIndex({ orgId: 1, createdAt: -1 }),
    col.createIndex({ callSid: 1 }, { unique: true, sparse: true }),
    col.createIndex({ orgId: 1, phoneNumberId: 1, createdAt: -1 }),
    col.createIndex({ orgId: 1, status: 1 }),
    // TTL index: auto-expire initiating calls that never connected (stale, 2 hours)
    col.createIndex({ createdAt: 1 }, { expireAfterSeconds: 7200, partialFilterExpression: { status: 'initiating' } }),
  ]);
}
