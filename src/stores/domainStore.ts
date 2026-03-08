import { getCollection } from '../db';
import type { DomainEntry, InboxEntry, InboxWebhook } from '../types';
import logger from '../utils/logger';
import { randomBytes, randomUUID } from 'crypto';
import type { WithId } from 'mongodb';
import { encryptSecretField, decryptSecretField } from '../lib/encryption';

type DomainDocument = WithId<DomainEntry>;

const getDomainsCollection = async () => {
  return getCollection<DomainDocument>('domains');
};

const stripId = (doc: DomainDocument): DomainEntry => {
  const { _id, ...rest } = doc;
  return rest;
};

const resolveInboxAddress = (inbox: InboxEntry, domainName?: string) => {
  if (domainName && inbox.localPart) {
    return {
      ...inbox,
      address: `${inbox.localPart}@${domainName}`,
    };
  }
  return inbox;
};

/**
 * Decrypt all webhook secrets in a domain entry after reading from DB.
 */
const decryptDomainSecrets = (domain: DomainEntry): DomainEntry => {
  const result = { ...domain };
  // Decrypt domain-level webhook secret
  if (result.webhook?.secret) {
    result.webhook = { ...result.webhook, secret: decryptSecretField(result.webhook.secret) as string };
  }
  // Decrypt inbox-level webhook secrets
  if (Array.isArray(result.inboxes)) {
    result.inboxes = result.inboxes.map(inbox => {
      if (!inbox.webhook?.secret) return inbox;
      return {
        ...inbox,
        webhook: { ...inbox.webhook, secret: decryptSecretField(inbox.webhook.secret) as string },
      };
    });
  }
  return result;
};

/**
 * Encrypt all webhook secrets in a domain entry before writing to DB.
 */
const encryptDomainSecrets = (domain: DomainEntry): DomainEntry => {
  const result = { ...domain };
  // Encrypt domain-level webhook secret
  if (result.webhook?.secret) {
    result.webhook = { ...result.webhook, secret: encryptSecretField(result.webhook.secret) as string };
  }
  // Encrypt inbox-level webhook secrets
  if (Array.isArray(result.inboxes)) {
    result.inboxes = result.inboxes.map(inbox => {
      if (!inbox.webhook?.secret) return inbox;
      return {
        ...inbox,
        webhook: { ...inbox.webhook, secret: encryptSecretField(inbox.webhook.secret) as string },
      };
    });
  }
  return result;
};

const getDomain = async (id: string) => {
  const collection = await getDomainsCollection();
  if (!collection) {
    return null;
  }

  const document = await collection.findOne({ id });
  if (!document) {
    return null;
  }
  return decryptDomainSecrets(stripId(document));
};

const getDomainByName = async (name: string) => {
  const collection = await getDomainsCollection();
  if (!collection) {
    return null;
  }

  const normalized = name.trim();
  const document = await collection.findOne({
    name: { $regex: `^${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
  });
  if (!document) {
    return null;
  }
  return decryptDomainSecrets(stripId(document));
};

const upsertDomain = async (entry: DomainEntry) => {
  const collection = await getDomainsCollection();
  if (!collection) {
    return null;
  }

  // Strip _id to avoid "Performing an update on the path '_id' would modify the immutable field '_id'" error
  const { _id, ...entryWithoutId } = entry;

  const encrypted = encryptDomainSecrets(entryWithoutId as DomainEntry);
  await collection.updateOne({ id: entry.id }, { $set: encrypted as Partial<DomainDocument> }, { upsert: true });
  return entry;
};

const listDomains = async (orgId?: string) => {
  const collection = await getDomainsCollection();
  if (!collection) {
    return [];
  }

  const documents = await collection.find(orgId ? { orgId } : {}).toArray();
  return documents.map(stripId).map(decryptDomainSecrets);
};

const listInboxes = async (domainId: string, orgId?: string) => {
  const domain = await getDomain(domainId);
  if (orgId && domain?.orgId && domain.orgId !== orgId) {
    return [];
  }
  
  const allInboxes = (domain?.inboxes || []).map((inbox) => resolveInboxAddress(inbox, domain?.name));
  
  // Filter by inbox-level orgId for proper isolation (critical for shared default domain)
  if (orgId) {
    return allInboxes.filter(inbox => inbox.orgId === orgId);
  }
  
  return allInboxes;
};

const getInbox = async (domainId: string, inboxId: string, orgId?: string) => {
  const domain = await getDomain(domainId);
  if (orgId && domain?.orgId && domain.orgId !== orgId) {
    return null;
  }
  
  const inbox = (domain?.inboxes?.find((entry) => entry.id === inboxId) || null);
  
  // Check inbox-level orgId for proper isolation (critical for shared default domain)
  if (inbox && orgId && inbox.orgId && inbox.orgId !== orgId) {
    return null;
  }
  
  return inbox ? resolveInboxAddress(inbox, domain?.name) : null;
};

const getInboxByLocalPart = async (domainId: string, localPart: string, orgId?: string) => {
  const domain = await getDomain(domainId);
  const normalized = localPart.split('+')[0].trim().toLowerCase();
  
  const inbox = domain?.inboxes?.find(
    (inbox) => (inbox.localPart || '').trim().toLowerCase() === normalized
  ) || null;
  
  // Check inbox-level orgId for proper isolation (critical for shared default domain)
  if (inbox && orgId && inbox.orgId && inbox.orgId !== orgId) {
    return null;
  }
  
  return inbox ? resolveInboxAddress(inbox, domain?.name) : null;
};

const getInboxById = async (inboxId: string, orgId?: string) => {
  const collection = await getDomainsCollection();
  if (!collection) {
    return null;
  }

  const domain = await collection.findOne(
    { 'inboxes.id': inboxId },
    { projection: { inboxes: 1, id: 1, name: 1 } }
  );
  if (!domain?.inboxes) {
    return null;
  }

  const rawInbox = domain.inboxes.find((inbox) => inbox.id === inboxId) || null;

  // Check inbox-level orgId for proper isolation (critical for shared default domain)
  if (rawInbox && orgId && rawInbox.orgId && rawInbox.orgId !== orgId) {
    return null;
  }

  if (!rawInbox) {
    return null;
  }

  // Decrypt webhook secret (same as getInbox / listInboxes via getDomain -> decryptDomainSecrets)
  const inbox = rawInbox.webhook?.secret
    ? { ...rawInbox, webhook: { ...rawInbox.webhook, secret: decryptSecretField(rawInbox.webhook.secret) as string } }
    : rawInbox;

  // Resolve inbox address from the parent domain name
  return resolveInboxAddress(inbox, domain.name);
};

const getDomainIdByInboxId = async (inboxId: string) => {
  const collection = await getDomainsCollection();
  if (!collection) {
    return null;
  }

  const domain = await collection.findOne({ 'inboxes.id': inboxId }, { projection: { id: 1 } });
  return domain?.id || null;
};

const upsertInbox = async ({
  domainId,
  inbox,
  orgId,
}: {
  domainId: string;
  inbox: Omit<InboxEntry, 'id'> & { id?: string };
  orgId?: string;
}) => {
  const domain = ((await getDomain(domainId)) || { id: domainId }) as DomainEntry;
  if (orgId && domain.orgId && domain.orgId !== orgId) {
    return null;
  }
  const current = domain.inboxes || [];
  const id = inbox.id || randomUUID();
  const address = domain.name ? `${inbox.localPart}@${domain.name}` : inbox.address;
  const updated: InboxEntry = {
    ...inbox,
    id,
    address,
    createdAt: inbox.createdAt || new Date().toISOString(),
    orgId: orgId || inbox.orgId || domain.orgId,
  };
  const index = current.findIndex(
    (item: InboxEntry) => item.id === id || item.localPart === inbox.localPart
  );
  if (index === -1) {
    current.push(updated);
  } else {
    const existing = current[index];
    const mergedWebhook = updated.webhook ?? existing.webhook;
    current[index] = { ...existing, ...updated, webhook: mergedWebhook };
    if (process.env.DEBUG_INBOX_WEBHOOKS === 'true') {
      const before = existing.webhook ? { ...existing.webhook } : null;
      const after = mergedWebhook ? { ...mergedWebhook } : null;
      logger.info('🧷 Inbox webhook merge', {
        domainId,
        inboxId: existing.id,
        localPart: existing.localPart,
        before,
        after,
        receivedWebhook:
          Object.prototype.hasOwnProperty.call(updated, 'webhook') ? updated.webhook : undefined,
      });
    }
  }

  await upsertDomain({ ...domain, inboxes: current });
  return updated;
};

const updateInboxWebhook = async ({
  domainId,
  inboxId,
  webhook,
  orgId,
}: {
  domainId: string;
  inboxId: string;
  webhook: InboxWebhook;
  orgId?: string;
}) => {
  const domain = await getDomain(domainId);
  if (!domain || !domain.inboxes) {
    return null;
  }

  // For non-shared domains, check domain-level org ID
  if (domain.orgId && orgId && domain.orgId !== orgId) {
    return null;
  }

  const index = domain.inboxes.findIndex((item) => item.id === inboxId);
  if (index === -1) {
    return null;
  }

  // For shared domains (no domain.orgId), check inbox-level org ID
  // For non-shared domains, this is an additional safety check
  if (orgId && domain.inboxes[index].orgId !== orgId) {
    return null;
  }

  const existing = domain.inboxes[index].webhook;
  const secret = webhook.secret || existing?.secret || randomBytes(24).toString('hex');

  domain.inboxes[index] = {
    ...domain.inboxes[index],
    webhook: {
      ...webhook,
      secret,
    },
  };

  if (process.env.DEBUG_INBOX_WEBHOOKS === 'true') {
    logger.info('🧷 Inbox webhook updated', {
      domainId,
      inboxId,
      before: existing || null,
      after: domain.inboxes[index].webhook,
      isSharedDomain: !domain.orgId,
      inboxOrgId: domain.inboxes[index].orgId,
      requestOrgId: orgId,
    });
  }

  await upsertDomain(domain);
  return domain.inboxes[index];
};

const removeInbox = async (domainId: string, inboxId: string, orgId?: string) => {
  const domain = await getDomain(domainId);
  if (!domain || !domain.inboxes) {
    return false;
  }
  if (orgId && domain.orgId && domain.orgId !== orgId) {
    return false;
  }

  const next = domain.inboxes.filter((inbox) => inbox.id !== inboxId);
  await upsertDomain({ ...domain, inboxes: next });
  return next.length !== domain.inboxes.length;
};

export default {
  getDomain,
  getDomainByName,
  upsertDomain,
  listDomains,
  listInboxes,
  getInbox,
  getInboxById,
  getDomainIdByInboxId,
  getInboxByLocalPart,
  upsertInbox,
  updateInboxWebhook,
  removeInbox,
};
