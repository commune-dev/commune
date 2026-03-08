/**
 * Vector search types — discriminated union by `channel`.
 *
 * Each channel owns its metadata shape. The `channel` field is the
 * discriminant: 'email' or 'sms'. QdrantService, EmailProcessor, and
 * SmsProcessor all pattern-match on it to build correct payloads/filters.
 */

// ─── Metadata stored in Qdrant ────────────────────────────────────

/** Fields shared across all channels */
interface BaseMessageMetadata {
  organizationId: string;
  inboxId: string;         // inbox_id for email, phone_number_id for SMS
  participants: string[];
  threadId: string;
  timestamp: Date;
  direction: 'inbound' | 'outbound';
}

/** Email-specific payload stored in Qdrant */
export interface EmailMessageMetadata extends BaseMessageMetadata {
  channel: 'email';
  domainId: string;
  subject: string;
  hasAttachments: boolean;
  attachmentCount: number;
  attachmentIds: string[];
}

/** SMS-specific payload stored in Qdrant */
export interface SmsMessageMetadata extends BaseMessageMetadata {
  channel: 'sms';
  phoneNumberId: string;
  fromNumber: string;
  toNumber: string;
}

/** Union type — use `metadata.channel` to narrow */
export type ConversationMetadata = EmailMessageMetadata | SmsMessageMetadata;

// ─── Zod schema for API route validation ─────────────────────────

import { z } from 'zod';

const BaseSearchFilterSchema = z.object({
  organizationId: z.string(),
  participants: z.array(z.string()).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const SearchFilterSchema = z.discriminatedUnion('channel', [
  BaseSearchFilterSchema.extend({
    channel: z.literal('email'),
    inboxIds: z.array(z.string()).optional(),
    domainId: z.string().optional(),
  }),
  BaseSearchFilterSchema.extend({
    channel: z.literal('sms'),
    phoneNumberId: z.string().optional(),
    fromNumber: z.string().optional(),
    toNumber: z.string().optional(),
  }),
]).or(BaseSearchFilterSchema);

// ─── Search filters ───────────────────────────────────────────────

interface BaseSearchFilter {
  organizationId: string;
  participants?: string[];
  startDate?: string;
  endDate?: string;
}

export interface EmailSearchFilter extends BaseSearchFilter {
  channel: 'email';
  inboxIds?: string[];
  domainId?: string;
}

export interface SmsSearchFilter extends BaseSearchFilter {
  channel: 'sms';
  phoneNumberId?: string;
  fromNumber?: string;
  toNumber?: string;
}

/** No-channel filter — searches across all indexed content */
export type SearchFilter = EmailSearchFilter | SmsSearchFilter | BaseSearchFilter;

// ─── Search result / vector data ──────────────────────────────────

export interface SearchOptions {
  limit?: number;
  offset?: number;
  minScore?: number;
}

export interface SearchResult {
  id: string;
  score: number;
  metadata: ConversationMetadata;
}

export type SearchType = 'vector' | 'agent';

export interface VectorData {
  id: string;
  vector: number[];
  payload: ConversationMetadata;
}
