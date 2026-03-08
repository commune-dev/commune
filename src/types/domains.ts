import type { Channel } from './messages';

export interface DomainWebhook {
  id?: string;
  endpoint?: string;
  events?: string[];
  secret?: string | null;
}

export interface InboxWebhook {
  endpoint?: string;
  events?: string[];
  secret?: string;
}

export interface InboxEntry {
  id: string;
  orgId?: string;
  localPart: string;
  address?: string;
  displayName?: string;
  agent?: {
    id?: string;
    name?: string;
    metadata?: Record<string, unknown>;
  };
  webhook?: InboxWebhook;
  extractionSchema?: {
    name: string;
    description?: string;
    schema: Record<string, any>;
    enabled: boolean;
  };
  limits?: {
    emailsPerDay?: number;
    emailsPerHour?: number;
  };
  createdAt?: string;
  status?: string;
}

export interface DomainEntry {
  _id?: unknown;
  id: string;
  orgId?: string;
  name?: string;
  status?: string;
  region?: string;
  records?: unknown[];
  createdAt?: string;
  webhook?: DomainWebhook;
  inboxes?: InboxEntry[];
}

export interface SendMessagePayload {
  channel: Channel;
  thread_id?: string;
  to: string | string[];
  text?: string;
  html?: string;
  attachments?: string[]; // Array of attachment IDs
  subject?: string;
  cc?: string[];
  bcc?: string[];
  headers?: Record<string, string>;
  replyTo?: string | string[];
  reply_to?: string | string[];
  domainId?: string;
  inboxId?: string;
  domain?: string;
  from?: string;
  localPart?: string;
  /** Pre-generated message ID from the API layer — used to return a stable ID in the 202 response. */
  _messageId?: string;
}
