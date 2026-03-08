import { getCollection } from '../db';

/**
 * Ensure indexes for tools and voice_agents collections.
 * Separate from individual stores to keep the store files clean.
 */
export async function ensureVoiceIndexes(): Promise<void> {
  const [toolsCol, agentsCol] = await Promise.all([
    getCollection('tools'),
    getCollection('voice_agents'),
  ]);

  await Promise.all([
    // tools: lookup by org + list, unique tool name per org
    toolsCol?.createIndex({ orgId: 1, createdAt: -1 }),
    toolsCol?.createIndex({ id: 1 }, { unique: true }),
    toolsCol?.createIndex({ orgId: 1, name: 1 }, { unique: true }),

    // voice_agents: one agent per phone number (unique), lookup by voiceAgentId
    agentsCol?.createIndex({ orgId: 1, phoneNumberId: 1 }, { unique: true }),
    agentsCol?.createIndex({ id: 1 }, { unique: true }),
    agentsCol?.createIndex({ orgId: 1, id: 1 }),
  ]);
}
