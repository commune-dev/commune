import { randomUUID } from 'crypto';
import { getCollection } from '../db';

export type UserRecord = {
  _id?: string;
  id: string;
  orgId: string;
  email: string;
  name?: string;
  passwordHash: string;
  verifiedAt?: string | null;
  createdAt: string;
};

const collectionName = 'users';

const ensureIndexes = async () => {
  const collection = await getCollection<UserRecord>(collectionName);
  if (!collection) {
    return;
  }

  await collection.createIndex({ email: 1 }, { unique: true });
  await collection.createIndex({ orgId: 1 });
  await collection.createIndex({ id: 1, status: 1, emailVerified: 1 });
};

const createUser = async ({
  orgId,
  email,
  name,
  passwordHash,
}: {
  orgId: string;
  email: string;
  name?: string;
  passwordHash: string;
}) => {
  const collection = await getCollection<UserRecord>(collectionName);
  if (!collection) {
    return null;
  }

  const record: UserRecord = {
    id: `usr_${randomUUID()}`,
    orgId,
    email,
    name,
    passwordHash,
    createdAt: new Date().toISOString(),
    verifiedAt: null,
  };

  await collection.insertOne(record);
  return record;
};

const getUserByEmail = async (email: string) => {
  const collection = await getCollection<UserRecord>(collectionName);
  if (!collection) {
    return null;
  }

  return collection.findOne({ email });
};

const getUserById = async (id: string) => {
  const collection = await getCollection<UserRecord>(collectionName);
  if (!collection) {
    return null;
  }

  return collection.findOne({ id });
};

const markVerified = async (id: string) => {
  const collection = await getCollection<UserRecord>(collectionName);
  if (!collection) {
    return null;
  }

  const verifiedAt = new Date().toISOString();
  await collection.updateOne({ id }, { $set: { verifiedAt } });
  return verifiedAt;
};

export default {
  ensureIndexes,
  createUser,
  getUserByEmail,
  getUserById,
  markVerified,
};
