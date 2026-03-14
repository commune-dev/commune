import domainStore from '../../stores/domainStore';
import { decodeThreadToken } from '../../lib/threadToken';
import type { DomainEntry } from '../../types';

const normalizeRecipient = (value: unknown) => {
  const addr = extractEmailAddress(value);
  if (!addr) {
    return null;
  }
  const [localPartRaw, domainRaw] = addr.split('@');
  const localPart = (localPartRaw || '').trim().toLowerCase();
  const domain = (domainRaw || '').trim().toLowerCase();
  if (!localPart || !domain) {
    return null;
  }
  return {
    raw: addr,
    normalized: `${localPart}@${domain}`,
    localPart,
    localPartBase: localPart.split('+')[0],
    domain,
  };
};

const extractEmailAddress = (value: unknown) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  const match = trimmed.match(/<([^>]+)>/);
  const candidate = (match ? match[1] : trimmed).trim();
  if (!candidate.includes('@')) {
    return null;
  }
  return candidate;
};

const extractThreadTag = (localPart?: string | null) => {
  if (!localPart) {
    return null;
  }
  const plusIndex = localPart.indexOf('+');
  if (plusIndex === -1) {
    return null;
  }
  const tag = localPart.slice(plusIndex + 1);
  if (!tag) {
    return null;
  }

  // New short tokens: "t" + 12 hex chars (e.g. "t1a2b3c4d5e6")
  if (/^t[0-9a-f]{12}$/.test(tag)) {
    const threadId = decodeThreadToken(tag);
    return threadId; // null if not in cache
  }

  // Legacy opaque routing tokens: "r.<base64>.<sig>" or "r-<base64>-<sig>"
  if (tag.startsWith('r.') || tag.startsWith('r-')) {
    const threadId = decodeThreadToken(tag);
    return threadId; // null if invalid/tampered
  }

  // Legacy support: raw thread_/conv_ prefixes (backwards compat)
  if (tag.startsWith('thread_') || tag.startsWith('conv_')) {
    return tag;
  }

  return null;
};

const inferDomainFromPayload = async (
  body: string,
  domainIdFromQuery?: string
): Promise<{ domainId: string | null; domainEntry: DomainEntry | null; threadTag: string | null; rawRoutingToken: string | null }> => {
  if (domainIdFromQuery) {
    const entry = await domainStore.getDomain(domainIdFromQuery);
    return { domainId: domainIdFromQuery, domainEntry: entry, threadTag: null, rawRoutingToken: null };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { domainId: null, domainEntry: null, threadTag: null, rawRoutingToken: null };
  }

  const eventType = String(parsed?.type || '');
  const toList = Array.isArray(parsed?.data?.to) ? parsed.data.to : [];
  const fromValue = parsed?.data?.from;
  const parsedRecipients = toList
    .map((recipient: unknown) => normalizeRecipient(recipient))
    .filter(Boolean) as Array<NonNullable<ReturnType<typeof normalizeRecipient>>>;

  let inboundThreadTag =
    parsedRecipients
      .map((recipient) => extractThreadTag(recipient.localPart))
      .find(Boolean) || null;

  let rawRoutingToken: string | null = null;
  if (!inboundThreadTag) {
    for (const r of parsedRecipients) {
      const plusIdx = r.localPart.indexOf('+');
      if (plusIdx !== -1) {
        const tag = r.localPart.slice(plusIdx + 1);
        if (/^t[0-9a-f]{12}$/.test(tag)) {
          rawRoutingToken = tag;
          break;
        }
      }
    }
  }

  const fromRecipient = fromValue ? normalizeRecipient(fromValue) : null;
  const toDomain = parsedRecipients[0]?.domain || null;

  const primaryDomain =
    eventType === 'email.received'
      ? toDomain
      : fromRecipient?.domain || toDomain;

  if (!primaryDomain) {
    return { domainId: domainIdFromQuery || null, domainEntry: null, threadTag: inboundThreadTag, rawRoutingToken };
  }

  const domainEntry = await domainStore.getDomainByName(primaryDomain);
  return { domainId: domainEntry?.id || null, domainEntry, threadTag: inboundThreadTag, rawRoutingToken };
};

// ─── Webhook Idempotency ─────────────────────────────────────────────────────
// Track processed event IDs to prevent duplicate processing.
// Uses Redis when available, falls back to in-memory LRU.
const processedWebhookIds = new Map<string, number>();
const WEBHOOK_DEDUP_TTL_MS = 60 * 60 * 1000; // 1 hour
const WEBHOOK_DEDUP_MAX_SIZE = 10000;

const isWebhookDuplicate = async (eventId: string): Promise<boolean> => {
  try {
    const { getRedisClient } = await import('../../lib/redis');
    const redis = getRedisClient();
    if (redis) {
      const key = `webhook:dedup:${eventId}`;
      const exists = await redis.get(key);
      if (exists) return true;
      await redis.set(key, '1', 'EX', 3600);
      return false;
    }
  } catch {
    // Redis unavailable, fall through to in-memory
  }

  if (processedWebhookIds.has(eventId)) return true;

  if (processedWebhookIds.size >= WEBHOOK_DEDUP_MAX_SIZE) {
    const now = Date.now();
    for (const [id, ts] of processedWebhookIds) {
      if (now - ts > WEBHOOK_DEDUP_TTL_MS) processedWebhookIds.delete(id);
    }
    if (processedWebhookIds.size >= WEBHOOK_DEDUP_MAX_SIZE) {
      const oldest = processedWebhookIds.keys().next().value;
      if (oldest) processedWebhookIds.delete(oldest);
    }
  }

  processedWebhookIds.set(eventId, Date.now());
  return false;
};

export {
  extractEmailAddress,
  normalizeRecipient,
  extractThreadTag,
  inferDomainFromPayload,
  isWebhookDuplicate,
};
