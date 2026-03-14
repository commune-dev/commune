export interface SuppressionEntry {
  _id: string;
  email: string;
  reason: 'bounce' | 'complaint' | 'manual' | 'spam_trap' | 'unsubscribe';
  type: 'hard' | 'soft' | 'spam' | 'permanent';
  source: 'inbox' | 'domain' | 'global';
  inbox_id?: string;
  domain_id?: string;
  created_at?: string;
  expires_at?: string;
  message_id?: string;
  metadata?: {
    bounce_reason?: string;
    bounce_diagnostic?: string | null;
    complaint_type?: string;
    original_subject?: string;
    soft_bounce_count?: number;
    unsubscribed_via?: string;
    org_id?: string;
  };
}

export interface SecurityStateEntry {
  _id: string;
  type: 'soft_bounce' | string;
  key: string;
  created_at?: string;
  updated_at?: string;
  expires_at?: string;
  inbox_id?: string;
  consecutive_count?: number;
  first_bounce_at?: string;
  last_bounce_at?: string;
  last_reason?: string;
  metadata?: Record<string, unknown>;
}

export interface DeliveryEvent {
  _id: string;
  message_id: string;
  event_type: 'sent' | 'delivered' | 'bounced' | 'complained' | 'failed' | 'delivery_delayed' | 'suppressed' | 'opened' | 'clicked';
  event_data: any & {
    orphan?: boolean;
    orphan_reason?: 'message_not_found' | 'missing_email_id' | string;
    lookup_email_id?: string | null;
  };
  processed_at?: string;
  inbox_id?: string;
  domain_id?: string;
  org_id?: string;
}

export interface InboxMetrics {
  _id: string;
  inbox_id: string;
  domain_id: string;
  date: string;
  metrics: {
    sent: number;
    delivered: number;
    bounced: number;
    complained: number;
    failed: number;
    suppressed: number;
    orphan_events: number;
    delivery_rate: number;
    bounce_rate: number;
    complaint_rate: number;
    failure_rate: number;
    suppression_rate: number;
    orphan_event_rate: number;
  };
  updated_at: string;
}

export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'retrying' | 'dead';

export interface WebhookDeliveryAttempt {
  attempt: number;
  status_code: number | null;
  error: string | null;
  latency_ms: number;
  attempted_at: string;
}

export interface WebhookDelivery {
  _id: string;
  delivery_id: string;
  inbox_id: string;
  org_id?: string;
  message_id: string;
  endpoint: string;
  payload: Record<string, any>;
  payload_hash: string;
  status: WebhookDeliveryStatus;
  attempts: WebhookDeliveryAttempt[];
  attempt_count: number;
  max_attempts: number;
  next_retry_at: string | null;
  created_at: string;
  delivered_at: string | null;
  dead_at: string | null;
  last_error: string | null;
  last_status_code: number | null;
  delivery_latency_ms: number | null;
  signature_header: string | null;
  webhook_secret?: string | null;
}
