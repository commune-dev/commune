import { ObjectId } from 'mongodb';
import { randomUUID } from 'crypto';
import { getCollection } from '../db';
import type { Tool } from '../types/voice';

const COLLECTION = 'tools';

function serialize(doc: Record<string, unknown>): Tool {
  const { _id, ...rest } = doc;
  return rest as unknown as Tool;
}

export async function createTool(
  orgId: string,
  data: Omit<Tool, 'id' | 'orgId' | 'version' | 'createdAt' | 'updatedAt'>
): Promise<Tool> {
  const col = await getCollection<Record<string, unknown>>(COLLECTION);
  if (!col) throw new Error('DB unavailable');

  const now = new Date();
  const doc = {
    _id: new ObjectId(),
    id: `tl_${randomUUID().replace(/-/g, '')}`,
    orgId,
    ...data,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };

  await col.insertOne(doc);
  return serialize(doc);
}

export async function getToolById(orgId: string, id: string): Promise<Tool | null> {
  const col = await getCollection<Record<string, unknown>>(COLLECTION);
  if (!col) return null;
  const doc = await col.findOne({ id, orgId });
  return doc ? serialize(doc) : null;
}

export async function listTools(orgId: string): Promise<Tool[]> {
  const col = await getCollection<Record<string, unknown>>(COLLECTION);
  if (!col) return [];
  const docs = await col.find({ orgId }).sort({ createdAt: -1 }).toArray();
  return docs.map(serialize);
}

export async function updateTool(
  orgId: string,
  id: string,
  data: Partial<Pick<Tool, 'name' | 'description' | 'parameters' | 'implementation' | 'lastTestedAt' | 'lastTestResult' | 'lastTestDurationMs'>>
): Promise<Tool | null> {
  const col = await getCollection<Record<string, unknown>>(COLLECTION);
  if (!col) return null;

  const updateFields: Record<string, unknown> = { ...data, updatedAt: new Date() };

  // Increment version if name, description, parameters, or URL changed
  const versionBump = data.name || data.description || data.parameters || data.implementation?.url;
  const updateDoc: Record<string, unknown> = { $set: updateFields };
  if (versionBump) {
    (updateDoc as { $set: Record<string, unknown>; $inc?: Record<string, number> }).$inc = { version: 1 };
  }

  const result = await col.findOneAndUpdate(
    { id, orgId },
    updateDoc,
    { returnDocument: 'after' }
  );
  return result ? serialize(result) : null;
}

export async function deleteTool(orgId: string, id: string): Promise<boolean> {
  const col = await getCollection<Record<string, unknown>>(COLLECTION);
  if (!col) return false;
  const result = await col.deleteOne({ id, orgId });
  return result.deletedCount > 0;
}

/**
 * Check if a tool is referenced by any active voice agent.
 * Used before deletion to prevent orphaned tool references.
 */
export async function isToolInUse(orgId: string, toolId: string): Promise<boolean> {
  const col = await getCollection<Record<string, unknown>>('voice_agents');
  if (!col) return false;
  const agent = await col.findOne({ orgId, toolIds: toolId });
  return !!agent;
}

/**
 * Load full tool objects by IDs (for building a call session).
 * Returns only tools belonging to the given org.
 */
export async function getToolsByIds(orgId: string, toolIds: string[]): Promise<Tool[]> {
  if (toolIds.length === 0) return [];
  const col = await getCollection<Record<string, unknown>>(COLLECTION);
  if (!col) return [];
  const docs = await col.find({ id: { $in: toolIds }, orgId }).toArray();
  // Return in original order (toolIds order)
  const map = new Map(docs.map(d => [d.id as string, serialize(d)]));
  return toolIds.map(id => map.get(id)).filter((t): t is Tool => !!t);
}
