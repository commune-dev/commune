import { randomUUID } from 'crypto';
import { getCollection } from '../db';
import type { AttachmentRecord, UnifiedMessage } from '../types';
import { encryptMessageFields, decryptMessageFields, encryptAttachmentContent, decryptAttachmentContent, decrypt } from '../lib/encryption';

// Helper: decrypt an array of messages
const decryptMessages = (msgs: any[]): any[] => msgs.map(decryptMessageFields);

const ensureIndexes = async () => {
  const messages = await getCollection<UnifiedMessage>('messages');
  const attachments = await getCollection<AttachmentRecord>('attachments');
  if (messages) {
    await messages.createIndex({ thread_id: 1, created_at: -1 });
    await messages.createIndex({ channel: 1, message_id: 1 }, { unique: true });
    await messages.createIndex({ 'participants.identity': 1, created_at: -1 });
    await messages.createIndex({ 'metadata.inbox_id': 1, created_at: -1 });
    await messages.createIndex({ orgId: 1, created_at: -1 });
    await messages.createIndex({ 'metadata.message_id': 1 }); // For thread resolution by SMTP Message-ID
    await messages.createIndex({ 'metadata.resend_id': 1 });  // For thread resolution by Resend API ID
    await messages.createIndex({ 'metadata.ses_message_id': 1 }); // For SES delivery event lookup
    await messages.createIndex({ 'metadata.routing_token': 1 }); // For routing token DB fallback
    // Index for listThreads grouping/sorting on the pre-computed effective_thread_id field
    await messages.createIndex({ orgId: 1, effective_thread_id: 1, created_at: -1 });
    // Index for searchThreads $regex on plaintext search_summary
    await messages.createIndex({ orgId: 1, search_summary: 1 });
    // Dashboard inbox view: org-scoped inbox query with time sort
    await messages.createIndex(
      { orgId: 1, 'metadata.inbox_id': 1, created_at: -1 },
      { background: true, name: 'messages_inbox_view' }
    );
    // updateDeliveryStatus / getMessage / updateMessage query on message_id alone;
    // the existing compound { channel: 1, message_id: 1 } unique index cannot serve
    // single-field message_id lookups efficiently.
    await messages.createIndex(
      { message_id: 1 },
      { background: true, name: 'messages_by_message_id' }
    );
    // Delivery status queries (e.g. "find all bounced emails for an inbox")
    await messages.createIndex(
      { 'metadata.inbox_id': 1, 'metadata.delivery_status': 1 },
      { background: true, name: 'messages_delivery_status' }
    );
    // Thread lookup by orgId — thread_id is a top-level field on UnifiedMessage
    await messages.createIndex(
      { orgId: 1, thread_id: 1, created_at: -1 },
      { background: true, name: 'messages_by_thread' }
    );
  }
  if (attachments) {
    await attachments.createIndex({ attachment_id: 1 }, { unique: true });
    await attachments.createIndex({ message_id: 1 });
  }
};

const insertMessage = async (message: UnifiedMessage) => {
  const messages = await getCollection<UnifiedMessage>('messages');
  if (!messages) {
    return null;
  }

  // Normalize created_at to ISO 8601 format — Resend inbound uses Postgres-style
  // timestamps ("2026-02-10 15:46:01+00") while outbound uses ISO ("2026-02-10T15:14:47Z").
  // Without normalization, MongoDB string sort breaks (space < 'T').
  const rawCreatedAt = message.created_at || message.metadata?.created_at || new Date().toISOString();
  const createdAt = new Date(rawCreatedAt).toISOString();

  // Pre-compute effective_thread_id at write time so listThreads can sort on a real
  // indexed field instead of a computed $addFields value (which forces a full in-memory sort).
  const effectiveThreadId = message.thread_id || message.message_id;

  // Build a plaintext search_summary BEFORE encryption so searchThreads $regex can
  // actually match. metadata.subject and content are encrypted after this point —
  // regex on ciphertext never produces meaningful matches.
  const senderParticipant = message.participants?.find((p) => p.role === 'sender');
  const searchSummary = [
    message.metadata?.subject ?? '',
    senderParticipant?.identity ?? '',
    message.content ? message.content.substring(0, 500) : '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const { orgId, ...rest } = message;
  const rawDoc = {
    ...rest,
    ...(orgId ? { orgId } : {}),
    _id: message._id || randomUUID(),
    created_at: createdAt,
    effective_thread_id: effectiveThreadId,
    search_summary: searchSummary,
    metadata: {
      ...message.metadata,
      created_at: createdAt,
      delivery_status: 'sent' as const, // Default status
      delivery_data: {
        sent_at: createdAt
      }
    },
  };

  // Encrypt sensitive fields before storage
  const doc = encryptMessageFields(rawDoc);

  // Separate _id from the rest of the document for upsert
  const { _id, ...docWithoutId } = doc;

  await messages.updateOne(
    { channel: doc.channel, message_id: doc.message_id },
    {
      $set: docWithoutId,
      $setOnInsert: { _id },
    },
    { upsert: true }
  );

  // Invalidate overview cache for this inbox (fire-and-forget, non-blocking)
  if (doc.metadata?.inbox_id && doc.metadata?.domain_id) {
    const { default: overviewCacheService } = await import('../services/overviewCacheService');
    overviewCacheService.invalidateInboxCache(doc.metadata.domain_id, doc.metadata.inbox_id).catch(() => {});
  }

  return doc;
};

const insertAttachments = async (attachments: AttachmentRecord[]) => {
  const collection = await getCollection<AttachmentRecord>('attachments');
  if (!collection || attachments.length === 0) {
    return [];
  }

  const docs = attachments.map((attachment) => ({
    ...attachment,
    attachment_id: attachment.attachment_id || randomUUID(),
    content_base64: encryptAttachmentContent(attachment.content_base64 || null),
  }));

  if (docs.length) {
    await collection.insertMany(docs, { ordered: false }).catch(() => null);
  }

  return docs;
};

const getMessagesByThread = async (
  threadId: string,
  limit = 50,
  order: 'asc' | 'desc' = 'asc',
  orgId?: string
) => {
  const messages = await getCollection<UnifiedMessage>('messages');
  if (!messages) {
    return [];
  }

  const sort = order === 'desc' ? -1 : 1;
  const filter: Record<string, unknown> = { thread_id: threadId };
  if (orgId) {
    filter.orgId = orgId;
  }
  let results = await messages
    .find(filter)
    .sort({ created_at: sort })
    .limit(limit)
    .toArray();

  // Fallback: listThreads uses $ifNull['$thread_id','$message_id'], so a
  // threadId may actually be a message_id for messages with no thread_id.
  if (results.length === 0) {
    const fallbackFilter: Record<string, unknown> = { message_id: threadId };
    if (orgId) {
      fallbackFilter.orgId = orgId;
    }
    results = await messages
      .find(fallbackFilter)
      .sort({ created_at: sort })
      .limit(limit)
      .toArray();
  }

  return decryptMessages(results);
};

const getThreadMessages = async (threadId: string, orgId?: string) => {
  const messages = await getCollection<UnifiedMessage>('messages');
  if (!messages) {
    return [];
  }

  const filter: Record<string, unknown> = { thread_id: threadId };
  if (orgId) {
    filter.orgId = orgId;
  }
  
  let results = await messages
    .find(filter)
    .sort({ created_at: 1 })
    .toArray();

  // Fallback: threadId may be a message_id (from listThreads $ifNull fallback)
  if (results.length === 0) {
    const fallbackFilter: Record<string, unknown> = { message_id: threadId };
    if (orgId) {
      fallbackFilter.orgId = orgId;
    }
    results = await messages
      .find(fallbackFilter)
      .sort({ created_at: 1 })
      .toArray();
  }

  return decryptMessages(results);
};

const getLatestMessageInThread = async (threadId: string, orgId?: string) => {
  const messages = await getCollection<UnifiedMessage>('messages');
  if (!messages) {
    return null;
  }

  const filter: Record<string, unknown> = { thread_id: threadId };
  if (orgId) {
    filter.orgId = orgId;
  }
  const result = await messages
    .find(filter)
    .sort({ created_at: -1 })
    .limit(1)
    .next();
  return decryptMessageFields(result);
};

const getMessagesBySender = async ({
  identity,
  channel,
  before,
  after,
  limit = 50,
  order = 'desc',
  orgId,
}: {
  identity: string;
  channel?: string;
  before?: string;
  after?: string;
  limit?: number;
  order?: 'asc' | 'desc';
  orgId?: string;
}) => {
  const messages = await getCollection<UnifiedMessage>('messages');
  if (!messages) {
    return [];
  }

  const filter: Record<string, unknown> = {
    participants: { $elemMatch: { role: 'sender', identity } },
  };

  if (orgId) {
    filter.orgId = orgId;
  }

  if (channel) {
    filter.channel = channel;
  }

  if (before || after) {
    filter.created_at = {};
    if (before) {
      (filter.created_at as Record<string, unknown>).$lt = before;
    }
    if (after) {
      (filter.created_at as Record<string, unknown>).$gt = after;
    }
  }

  const sort = order === 'desc' ? -1 : 1;
  const results = await messages.find(filter).sort({ created_at: sort }).limit(limit).toArray();
  return decryptMessages(results);
};

const getMessagesByRecipient = async ({
  identity,
  channel,
  before,
  after,
  limit = 50,
  order = 'desc',
}: {
  identity: string;
  channel?: string;
  before?: string;
  after?: string;
  limit?: number;
  order?: 'asc' | 'desc';
}) => {
  const messages = await getCollection<UnifiedMessage>('messages');
  if (!messages) {
    return [];
  }

  const filter: Record<string, unknown> = {
    participants: { $elemMatch: { role: 'to', identity } },
  };

  if (channel) {
    filter.channel = channel;
  }

  if (before || after) {
    filter.created_at = {};
    if (before) {
      (filter.created_at as Record<string, unknown>).$lt = before;
    }
    if (after) {
      (filter.created_at as Record<string, unknown>).$gt = after;
    }
  }

  const sort = order === 'desc' ? -1 : 1;
  const results = await messages.find(filter).sort({ created_at: sort }).limit(limit).toArray();
  return decryptMessages(results);
};

const getMessagesByDomain = async ({
  domainId,
  channel,
  before,
  after,
  limit = 50,
  order = 'desc',
  orgId,
}: {
  domainId: string;
  channel?: string;
  before?: string;
  after?: string;
  limit?: number;
  order?: 'asc' | 'desc';
  orgId?: string;
}) => {
  const messages = await getCollection<UnifiedMessage>('messages');
  if (!messages) {
    return [];
  }

  const filter: Record<string, unknown> = {
    'metadata.domain_id': domainId,
  };

  if (orgId) {
    filter.orgId = orgId;
  }

  if (channel) {
    filter.channel = channel;
  }

  if (before || after) {
    filter.created_at = {};
    if (before) {
      (filter.created_at as Record<string, unknown>).$lt = before;
    }
    if (after) {
      (filter.created_at as Record<string, unknown>).$gt = after;
    }
  }

  const sort = order === 'desc' ? -1 : 1;
  const results = await messages.find(filter).sort({ created_at: sort }).limit(limit).toArray();
  return decryptMessages(results);
};

const getMessagesByInbox = async ({
  inboxId,
  channel,
  before,
  after,
  limit = 50,
  order = 'desc',
  orgId,
}: {
  inboxId: string;
  channel?: string;
  before?: string;
  after?: string;
  limit?: number;
  order?: 'asc' | 'desc';
  orgId?: string;
}) => {
  const messages = await getCollection<UnifiedMessage>('messages');
  if (!messages) {
    return [];
  }

  const filter: Record<string, unknown> = {
    'metadata.inbox_id': inboxId,
  };

  if (orgId) {
    filter.orgId = orgId;
  }

  if (channel) {
    filter.channel = channel;
  }

  if (before || after) {
    filter.created_at = {};
    if (before) {
      (filter.created_at as Record<string, unknown>).$lt = before;
    }
    if (after) {
      (filter.created_at as Record<string, unknown>).$gt = after;
    }
  }

  const sort = order === 'desc' ? -1 : 1;
  const results = await messages.find(filter).sort({ created_at: sort }).limit(limit).toArray();
  return decryptMessages(results);
};

const listThreads = async ({
  inboxId,
  domainId,
  limit = 20,
  cursor,
  order = 'desc',
  orgId,
  channel,
}: {
  inboxId?: string;
  domainId?: string;
  limit?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
  orgId?: string;
  channel?: string;
}) => {
  const messages = await getCollection<UnifiedMessage>('messages');
  if (!messages) {
    return { threads: [], next_cursor: null };
  }

  const matchFilter: Record<string, unknown> = {};
  if (inboxId) matchFilter['metadata.inbox_id'] = inboxId;
  if (domainId) matchFilter['metadata.domain_id'] = domainId;
  if (orgId) matchFilter.orgId = orgId;
  if (channel) matchFilter.channel = channel;

  // Decode cursor: base64 encoded JSON { last_message_at, id }
  let cursorFilter: Record<string, unknown> | null = null;
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (order === 'desc') {
        cursorFilter = {
          $or: [
            { last_message_at: { $lt: decoded.last_message_at } },
            { last_message_at: decoded.last_message_at, _id: { $lt: decoded.id } },
          ],
        };
      } else {
        cursorFilter = {
          $or: [
            { last_message_at: { $gt: decoded.last_message_at } },
            { last_message_at: decoded.last_message_at, _id: { $gt: decoded.id } },
          ],
        };
      }
    } catch {
      // Invalid cursor, ignore
    }
  }

  const sortDir = order === 'desc' ? -1 : 1;
  const fetchLimit = Math.min(limit, 100);

  const pipeline: Record<string, unknown>[] = [
    { $match: matchFilter },
    // Use the pre-computed effective_thread_id field written at insert time.
    // This avoids a $addFields stage that forces a full in-memory sort — MongoDB
    // can now satisfy the sort with the { orgId, effective_thread_id, created_at } index.
    // For legacy documents that pre-date this field, fall back via $ifNull at query time only.
    {
      $addFields: {
        _effective_thread_id: {
          $ifNull: ['$effective_thread_id', { $ifNull: ['$thread_id', '$message_id'] }],
        },
      },
    },
    {
      $sort: { _effective_thread_id: 1, created_at: -1 },
    },
    {
      $group: {
        _id: '$_effective_thread_id',
        subject: { $first: '$metadata.subject' },
        last_message_at: { $max: '$created_at' },
        first_message_at: { $min: '$created_at' },
        message_count: { $sum: 1 },
        participants: { $addToSet: '$participants' },
        snippet: { $last: '$content' },
        last_direction: { $first: '$direction' },
        inbox_id: { $first: '$metadata.inbox_id' },
        domain_id: { $first: '$metadata.domain_id' },
        has_attachments: {
          $max: {
            $cond: [{ $gt: [{ $size: { $ifNull: ['$attachments', []] } }, 0] }, true, false],
          },
        },
      },
    },
    ...(cursorFilter ? [{ $match: cursorFilter }] : []),
    { $sort: { last_message_at: sortDir, _id: sortDir } },
    { $limit: fetchLimit + 1 },
    {
      $project: {
        _id: 0,
        thread_id: '$_id',
        subject: 1,
        last_message_at: 1,
        first_message_at: 1,
        message_count: 1,
        snippet: 1, // keep full content — truncate AFTER decryption
        last_direction: 1,
        inbox_id: 1,
        domain_id: 1,
        has_attachments: 1,
      },
    },
  ];

  const results = await messages.aggregate(pipeline).toArray();

  // Decrypt subject and snippet — aggregation pipeline bypasses decryptMessageFields,
  // so encrypted fields (enc:...) need manual decryption here.
  // IMPORTANT: decrypt FIRST, then truncate snippet. Truncating encrypted ciphertext
  // corrupts it and makes decrypt() fail silently.
  for (const thread of results) {
    if (thread.subject && typeof thread.subject === 'string') {
      thread.subject = decrypt(thread.subject);
    }
    if (thread.snippet && typeof thread.snippet === 'string') {
      thread.snippet = decrypt(thread.snippet);
      // Truncate to 200 chars after decryption
      if (thread.snippet && thread.snippet.length > 200) {
        thread.snippet = thread.snippet.slice(0, 200);
      }
    }
  }

  let nextCursor: string | null = null;
  if (results.length > fetchLimit) {
    const lastItem = results[fetchLimit - 1];
    nextCursor = Buffer.from(
      JSON.stringify({ last_message_at: lastItem.last_message_at, id: lastItem.thread_id })
    ).toString('base64url');
    results.splice(fetchLimit);
  }

  return { threads: results, next_cursor: nextCursor };
};

const getAttachment = async (attachmentId: string) => {
  const attachments = await getCollection<AttachmentRecord>('attachments');
  if (!attachments) {
    return null;
  }

  const att = await attachments.findOne({ attachment_id: attachmentId });
  if (att && att.content_base64) {
    att.content_base64 = decryptAttachmentContent(att.content_base64);
  }
  return att;
};

// Delivery status priority system (higher = more severe / more final):
//   sent (1)  <  delivered (2)  <  bounced/complained/failed/suppressed (3)
// A status can only be overwritten by one of equal or higher priority.
const ALL_TERMINAL_STATUSES = ['delivered', 'bounced', 'failed', 'complained', 'suppressed'];
const NEGATIVE_TERMINAL_STATUSES = ['bounced', 'failed', 'complained', 'suppressed'];

const updateDeliveryStatus = async (
  messageId: string,
  status: 'sent' | 'delivered' | 'bounced' | 'failed' | 'complained' | 'suppressed' | 'opened',
  data?: any,
  inboxId?: string
) => {
  const messages = await getCollection<UnifiedMessage>('messages');
  if (!messages) {
    return null;
  }
  
  const updateDoc: any = {
    'metadata.delivery_status': status,
    'metadata.delivery_data.updated_at': new Date().toISOString(),
  };

  // Store the event timestamp from Resend
  if (data) {
    // Store all provided delivery data fields directly
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined && value !== null) {
        updateDoc[`metadata.delivery_data.${key}`] = value;
      }
    }
  }

  // Atomic guard: use MongoDB filter to prevent TOCTOU race conditions when
  // Resend fires multiple webhooks nearly simultaneously.
  //
  // Priority rules:
  //   'sent'      → cannot overwrite any terminal status
  //   'delivered'  → cannot overwrite negative outcomes (bounced/complained/failed/suppressed)
  //   negative     → can overwrite anything (highest priority)
  const filter: any = { message_id: messageId };
  if (status === 'sent') {
    filter['metadata.delivery_status'] = { $nin: ALL_TERMINAL_STATUSES };
  } else if (status === 'delivered') {
    filter['metadata.delivery_status'] = { $nin: NEGATIVE_TERMINAL_STATUSES };
  }
  
  await messages.updateOne(
    filter,
    { $set: updateDoc }
  );
};

const getMessageByResendId = async (messageId: string) => {
  const messages = await getCollection<UnifiedMessage>('messages');
  if (!messages) {
    return null;
  }

  const result = await messages.find(
    {
      $or: [
        { message_id: messageId },
        { 'metadata.resend_id': messageId },
        { 'metadata.ses_message_id': messageId },
      ],
    }
  ).sort({ created_at: -1 }).limit(1).next();
  return decryptMessageFields(result);
};

const getInboxDeliveryMetrics = async (
  inboxId: string | undefined,
  startDate: Date,
  endDate: Date,
  domainId?: string,
) => {
  const messages = await getCollection<UnifiedMessage>('messages');
  const deliveryEvents = await getCollection('delivery_events');
  if (!messages) {
    return {
      sent: 0,
      delivered: 0,
      bounced: 0,
      complained: 0,
      failed: 0,
      suppressed: 0,
      orphan_events: 0,
      delivery_rate: 0,
      bounce_rate: 0,
      complaint_rate: 0,
      failure_rate: 0,
      suppression_rate: 0,
      orphan_event_rate: 0,
    };
  }

  const messageMatch: Record<string, unknown> = {
    created_at: { $gte: startDate.toISOString(), $lte: endDate.toISOString() },
  };
  if (inboxId) messageMatch['metadata.inbox_id'] = inboxId;
  if (domainId) messageMatch['metadata.domain_id'] = domainId;

  const eventMatch: Record<string, unknown> = {
    processed_at: { $gte: startDate.toISOString(), $lte: endDate.toISOString() },
  };
  if (inboxId) eventMatch.inbox_id = inboxId;
  if (domainId) eventMatch.domain_id = domainId;
  
  const messagePipeline = [
    {
      $match: messageMatch,
    },
    {
      $group: {
        _id: null,
        sent: { $sum: { $cond: [{ $eq: ['$direction', 'outbound'] }, 1, 0] } },
        delivered: { $sum: { $cond: [{ $eq: ['$metadata.delivery_status', 'delivered'] }, 1, 0] } },
        bounced: { $sum: { $cond: [{ $eq: ['$metadata.delivery_status', 'bounced'] }, 1, 0] } },
        complained: { $sum: { $cond: [{ $eq: ['$metadata.delivery_status', 'complained'] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $eq: ['$metadata.delivery_status', 'failed'] }, 1, 0] } },
        suppressed: { $sum: { $cond: [{ $eq: ['$metadata.delivery_status', 'suppressed'] }, 1, 0] } }
      }
    }
  ];

  const [messageResult, eventResult, orphanEventsCount] = await Promise.all([
    messages.aggregate(messagePipeline).toArray(),
    deliveryEvents
      ? deliveryEvents.aggregate([
          { $match: eventMatch },
          { $group: { _id: '$event_type', count: { $sum: 1 } } },
        ]).toArray()
      : Promise.resolve([] as Array<{ _id: string; count: number }>),
    deliveryEvents
      ? deliveryEvents.countDocuments({ ...eventMatch, 'event_data.orphan': true })
      : Promise.resolve(0),
  ]);

  const messageMetrics = messageResult[0] || {
    sent: 0,
    delivered: 0,
    bounced: 0,
    complained: 0,
    failed: 0,
    suppressed: 0,
  };
  const eventMetrics = new Map<string, number>(
    (eventResult || []).map((item: any) => [item._id, item.count])
  );

  // Use message-level metrics as source of truth (atomic guards ensure correct final status).
  // Don't use Math.max with event counts — Resend sends multiple events per email
  // (e.g. both 'delivered' + 'complained'), which inflates counts.
  const sent = messageMetrics.sent || 0;
  const delivered = messageMetrics.delivered || 0;
  const bounced = messageMetrics.bounced || 0;
  const complained = messageMetrics.complained || 0;
  const failed = messageMetrics.failed || 0;
  const suppressed = messageMetrics.suppressed || 0;
  const total = sent || 1;

  return {
    sent,
    delivered,
    bounced,
    complained,
    failed,
    suppressed,
    orphan_events: orphanEventsCount || 0,
    delivery_rate: (delivered / total) * 100,
    bounce_rate: (bounced / total) * 100,
    complaint_rate: (complained / total) * 100,
    failure_rate: (failed / total) * 100,
    suppression_rate: (suppressed / total) * 100,
    orphan_event_rate: ((orphanEventsCount || 0) / total) * 100,
  };
};

const getMessage = async (messageId: string) => {
  const messages = await getCollection<UnifiedMessage>('messages');
  if (!messages) {
    return null;
  }
  
  const result = await messages.findOne({ message_id: messageId });
  return decryptMessageFields(result);
};

const updateMessage = async (messageId: string, updates: Record<string, any>) => {
  const messages = await getCollection<UnifiedMessage>('messages');
  if (!messages) {
    return null;
  }
  
  const updateDoc: Record<string, any> = {};
  for (const [key, value] of Object.entries(updates)) {
    updateDoc[key] = value;
  }
  
  const result = await messages.updateOne(
    { message_id: messageId },
    { $set: updateDoc }
  );
  
  return result;
};

/**
 * Resolve a thread_id by matching SMTP Message-IDs from inbound In-Reply-To / References
 * against ALL stored Message-ID variants in our database.
 *
 * RFC 5322 threading requires matching the In-Reply-To of a reply against the
 * Message-ID of the original message. The problem: different email providers use
 * different Message-ID formats:
 *
 *   - Resend uses:           <api-uuid@resend.dev>
 *   - Our custom header:     <uuid@yourdomain.com>
 *   - Plain Resend API ID:   api-uuid (no angle brackets)
 *
 * We search across ALL stored ID fields to maximize match probability:
 *   - metadata.message_id        (Resend-format: <id@resend.dev>)
 *   - metadata.custom_message_id (our custom: <uuid@domain>)
 *   - metadata.resend_id         (plain UUID from Resend API)
 *   - message_id                 (top-level, also plain Resend UUID)
 *
 * We also extract the bare UUID from angle-bracket-wrapped IDs to match
 * against plain stored IDs, and vice versa.
 */
const resolveThreadBySmtpIds = async (
  smtpMessageIds: string[],
  orgId?: string
): Promise<string | null> => {
  if (!smtpMessageIds.length) return null;

  const messages = await getCollection<UnifiedMessage>('messages');
  if (!messages) return null;

  // Build an expanded set of IDs to search for.
  // Given <abc123@resend.dev>, also try: abc123, <abc123@resend.dev>
  // Given <uuid@yourdomain.com>, also try: uuid
  const expandedIds = new Set<string>();
  for (const id of smtpMessageIds) {
    expandedIds.add(id);
    // Strip angle brackets: <foo@bar> → foo@bar
    const stripped = id.replace(/^<|>$/g, '');
    expandedIds.add(stripped);
    // Extract local part before @: foo@bar → foo
    const atIdx = stripped.indexOf('@');
    if (atIdx > 0) {
      expandedIds.add(stripped.slice(0, atIdx));
    }
    // Also try wrapping plain IDs in Resend format
    if (!id.startsWith('<')) {
      expandedIds.add(`<${id}@resend.dev>`);
    }
  }

  const allIds = [...expandedIds];

  const filter: Record<string, unknown> = {
    $or: [
      { 'metadata.message_id': { $in: allIds } },
      { 'metadata.custom_message_id': { $in: allIds } },
      { 'metadata.resend_id': { $in: allIds } },
      { message_id: { $in: allIds } },
    ],
  };
  if (orgId) filter.orgId = orgId;

  // Prefer the earliest matching message (root of thread)
  const result = await messages
    .find(filter)
    .sort({ created_at: 1 })
    .limit(1)
    .next();

  return result?.thread_id || null;
};

/**
 * Look up a thread_id by its short routing token (stored in metadata.routing_token).
 * Used as a DB fallback when the in-memory token cache doesn't have the mapping
 * (e.g. after a server restart).
 */
const resolveThreadByRoutingToken = async (
  routingToken: string,
  orgId?: string
): Promise<string | null> => {
  const messages = await getCollection<UnifiedMessage>('messages');
  if (!messages) return null;

  const filter: Record<string, unknown> = {
    'metadata.routing_token': routingToken,
  };
  if (orgId) filter.orgId = orgId;

  const result = await messages
    .find(filter)
    .sort({ created_at: 1 })
    .limit(1)
    .next();

  return result?.thread_id || null;
};

/**
 * Search threads by subject or content substring match.
 * Uses MongoDB $regex for text search — works without any external search service.
 * Returns thread summaries similar to listThreads.
 */
const searchThreads = async ({
  query,
  inboxId,
  domainId,
  orgId,
  limit = 20,
}: {
  query: string;
  inboxId?: string;
  domainId?: string;
  orgId?: string;
  limit?: number;
}) => {
  const messages = await getCollection<UnifiedMessage>('messages');
  if (!messages) return [];

  // Escape regex special chars for safe $regex usage
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // search_summary is stored as plaintext (lowercased) at write time — it contains
  // the subject, sender identity, and first 500 chars of the message body before
  // encryption. Matching against the encrypted metadata.subject / content fields
  // never works because they carry an "enc:" prefix and random ciphertext.
  const matchFilter: Record<string, unknown> = {
    search_summary: { $regex: escaped, $options: 'i' },
  };
  if (inboxId) matchFilter['metadata.inbox_id'] = inboxId;
  if (domainId) matchFilter['metadata.domain_id'] = domainId;
  if (orgId) matchFilter.orgId = orgId;

  const pipeline = [
    { $match: matchFilter },
    { $sort: { created_at: -1 as const } },
    {
      $group: {
        _id: '$thread_id',
        subject: { $first: '$metadata.subject' },
        last_message_at: { $max: '$created_at' },
        message_count: { $sum: 1 },
        snippet: { $first: '$content' },
        last_direction: { $first: '$direction' },
        inbox_id: { $first: '$metadata.inbox_id' },
        domain_id: { $first: '$metadata.domain_id' },
      },
    },
    { $sort: { last_message_at: -1 as const } },
    { $limit: limit },
    {
      $project: {
        _id: 0,
        thread_id: '$_id',
        subject: 1,
        last_message_at: 1,
        message_count: 1,
        snippet: { $substrBytes: [{ $ifNull: ['$snippet', ''] }, 0, 200] },
        last_direction: 1,
        inbox_id: 1,
        domain_id: 1,
      },
    },
  ];

  const results = await messages.aggregate(pipeline).toArray();

  // Decrypt subject and snippet
  for (const thread of results) {
    if (thread.subject && typeof thread.subject === 'string') {
      thread.subject = decrypt(thread.subject);
    }
    if (thread.snippet && typeof thread.snippet === 'string') {
      thread.snippet = decrypt(thread.snippet);
    }
  }

  return results;
};

export default {
  ensureIndexes,
  insertMessage,
  insertAttachments,
  getMessagesByThread,
  getThreadMessages,
  getLatestMessageInThread,
  getMessagesBySender,
  getMessagesByRecipient,
  getMessagesByDomain,
  getMessagesByInbox,
  listThreads,
  searchThreads,
  getAttachment,
  updateDeliveryStatus,
  getMessageByResendId,
  getInboxDeliveryMetrics,
  getMessage,
  updateMessage,
  resolveThreadBySmtpIds,
  resolveThreadByRoutingToken,
};
