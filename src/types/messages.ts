export type Channel = 'email' | 'sms';
export type Direction = 'inbound' | 'outbound';
export type ParticipantRole =
  | 'sender'
  | 'to'
  | 'cc'
  | 'bcc'
  | 'mentioned'
  | 'participant';

export interface Participant {
  role: ParticipantRole;
  identity: string;
}

export interface MessageMetadata {
  created_at: string;
  subject?: string;
  in_reply_to?: string | null;
  references?: string[];
  is_private?: boolean;
  domain_id?: string | null;
  inbox_id?: string | null;
  inbox_address?: string | null;
  message_id?: string | null;
  resend_id?: string | null;
  delivery_status?: 'sent' | 'delivered' | 'bounced' | 'failed' | 'complained' | 'suppressed' | 'blocked' | 'credit_limit';
  delivery_data?: {
    sent_at?: string;
    delivered_at?: string;
    bounced_at?: string;
    failed_at?: string;
    complained_at?: string;
    bounce_reason?: string;
    bounce_type?: 'hard' | 'soft';
    failure_reason?: string;
    last_attempt?: string;
  };
  extracted_data?: Record<string, any>;
  spam_checked?: boolean;
  spam_score?: number;
  spam_action?: 'reject' | 'flag' | 'accept';
  spam_flagged?: boolean;
  spam_reasons?: string[];
  prompt_injection_checked?: boolean;
  prompt_injection_detected?: boolean;
  prompt_injection_risk?: 'none' | 'low' | 'medium' | 'high' | 'critical';
  prompt_injection_score?: number;
  prompt_injection_signals?: string;
  prompt_injection_model_checked?: boolean;
  prompt_injection_model_provider?: string;
  prompt_injection_model_version?: string;
  prompt_injection_model_score?: number;
  prompt_injection_model_error?: string;
  prompt_injection_model_tier?: 'free' | 'agent_pro' | 'business' | 'enterprise';
  prompt_injection_model_allowed?: boolean;
  prompt_injection_fusion_score?: number;
  prompt_injection_fusion_version?: string;
  prompt_injection_reason_codes?: string[];
  prompt_injection_disagreement?: 'model_high_rule_low' | 'rule_high_model_low';
  attachment_ids?: string[];
  has_attachments?: boolean;
  attachment_count?: number;
  commune_message_id?: string | null;
  // SMS-specific
  phone_number_id?: string;
  from_number?: string;
  to_number?: string;
  twilio_sid?: string;
  sms_segments?: number;
  credits_charged?: number;
  num_media?: number;
  mms_media?: Array<{ url: string; contentType: string; storageUrl?: string; attachmentId?: string }>;
}

export interface UnifiedMessage {
  _id?: string;
  orgId?: string;
  channel: Channel;
  message_id: string;
  thread_id: string;
  direction: Direction;
  participants: Participant[];
  content: string;
  content_html?: string | null;
  attachments: string[];
  created_at: string;
  metadata: MessageMetadata;
  /** Pre-computed sort key: thread_id if present, else message_id. Stored as a real field so MongoDB can use an index instead of sorting on a computed $addFields value. */
  effective_thread_id?: string;
  /** Plaintext search summary for $regex queries. Stored unencrypted alongside encrypted content/subject so search actually works. */
  search_summary?: string;
}

export interface AttachmentRecord {
  attachment_id: string;
  message_id: string;
  filename: string;
  mime_type: string;
  size: number;
  content_base64: string | null;
  source: Channel;
  source_url?: string | null;
  download_error?: boolean;
  storage_type?: 'cloudinary' | 'database';
  cloudinary_url?: string | null;
  cloudinary_public_id?: string | null;
}

export interface AttachmentMetadata {
  attachment_id: string;
  filename: string;
  mime_type: string;
  size: number;
}
