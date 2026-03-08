import { getCollection } from '../db';
import { createHash, randomBytes } from 'crypto';

export type ApiKeyRecord = {
  _id?: string;
  keyHash: string;
  prefix: string;
  name?: string;
  orgId?: string;
  createdAt: string;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
};

const collectionName = 'api_keys';

const hashKey = (key: string) => {
  return createHash('sha256').update(key, 'utf8').digest('hex');
};

const generateKey = () => {
  const raw = randomBytes(24).toString('hex');
  return `ck_live_${raw}`;
};

const ensureIndexes = async () => {
  const collection = await getCollection<ApiKeyRecord>(collectionName);
  if (!collection) {
    return;
  }

  await collection.createIndex({ keyHash: 1 }, { unique: true });
  await collection.createIndex({ keyPrefix: 1, status: 1 });
  await collection.createIndex({ createdAt: -1 });
};

const createApiKey = async ({ name, orgId }: { name?: string; orgId?: string }) => {
  const collection = await getCollection<ApiKeyRecord>(collectionName);
  if (!collection) {
    return null;
  }

  const key = generateKey();
  const keyHash = hashKey(key);
  const createdAt = new Date().toISOString();
  const prefix = key.slice(0, 10);

  const record: ApiKeyRecord = {
    keyHash,
    prefix,
    name,
    orgId,
    createdAt,
    lastUsedAt: null,
    revokedAt: null,
  };

  await collection.insertOne(record);

  return { key, record };
};

const listApiKeys = async ({ orgId }: { orgId?: string } = {}) => {
  const collection = await getCollection<ApiKeyRecord>(collectionName);
  if (!collection) {
    return [];
  }

  return collection
    .find(orgId ? { orgId } : {}, { projection: { keyHash: 0 } })
    .sort({ createdAt: -1 })
    .toArray();
};

const revokeApiKey = async (id: string, orgId?: string) => {
  const collection = await getCollection<ApiKeyRecord>(collectionName);
  if (!collection) {
    return null;
  }

  const revokedAt = new Date().toISOString();
  const result = await collection.findOneAndUpdate(
    orgId ? { _id: id as any, orgId } : { _id: id as any },
    { $set: { revokedAt } },
    { returnDocument: 'after', projection: { keyHash: 0 } }
  );

  return result || null;
};

const findApiKey = async (token: string) => {
  const collection = await getCollection<ApiKeyRecord>(collectionName);
  if (!collection) {
    return null;
  }

  const keyHash = hashKey(token);
  const record = await collection.findOne({
    keyHash,
    revokedAt: null,
    orgId: { $exists: true },
  });
  return record || null;
};

const touchApiKey = async (token: string) => {
  const collection = await getCollection<ApiKeyRecord>(collectionName);
  if (!collection) {
    return null;
  }

  const keyHash = hashKey(token);
  const lastUsedAt = new Date().toISOString();
  await collection.updateOne({ keyHash }, { $set: { lastUsedAt } });
  return true;
};

export default {
  ensureIndexes,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  findApiKey,
  touchApiKey,
};
