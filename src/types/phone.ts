// ─── Phone Number & SMS Types ────────────────────────────────────

export interface PhoneNumberCapabilities {
  sms: boolean;
  voice: boolean;
  mms: boolean;
}

export interface PhoneNumberAutoReply {
  enabled: boolean;
  body: string;
}

export interface PhoneNumber {
  id: string;                        // our UUID (pn_...)
  orgId: string;
  twilioSid: string;                 // PN... SID from Twilio
  twilioSubaccountSid: string;       // AC... SID of the org's Twilio subaccount
  twilioMessagingServiceSid: string; // MG... SID for this org
  number: string;                    // E.164 e.g. +18005551234
  numberType: 'local' | 'tollfree' | 'shortcode';
  friendlyName?: string;
  country: string;                   // ISO-3166 e.g. US, CA, GB
  capabilities: PhoneNumberCapabilities;
  allowList: string[];               // E.164 list; empty = allow all
  blockList: string[];               // E.164 list; always deny regardless of allowList
  status: 'active' | 'released' | 'suspended_non_payment';
  releasedAt?: Date;                 // set on release (30-day cooldown enforced from this)
  a2pCampaignSid?: string;          // set after A2P 10DLC campaign approved
  autoReply?: PhoneNumberAutoReply;
  webhook?: {
    endpoint?: string;
    secret?: string;
    events?: string[];
  };
  creditCostPerMonth: number;        // snapshot at purchase time (150 credits)
  createdAt: Date;
  updatedAt: Date;
}

export interface AvailableNumber {
  phoneNumber: string;               // E.164
  friendlyName: string;
  region?: string;
  isoCountry: string;
  capabilities: PhoneNumberCapabilities;
  beta: boolean;
}

// ─── SMS Suppression (opt-out tracking) ─────────────────────────

export type SmsSuppressionReason = 'stop' | 'unsubscribe' | 'blocked' | 'manual';

export interface SmsSuppression {
  id: string;
  orgId: string;
  phoneNumber: string;               // external E.164 that opted out
  phoneNumberId?: string | null;     // null = org-wide suppression; set = per-number
  reason: SmsSuppressionReason;
  createdAt: Date;
}

// ─── Credit System ────────────────────────────────────────────────

export interface PhoneCredits {
  included: number;                  // resets each billing cycle
  purchased: number;                 // rolls over from add-on bundles
  usedThisCycle: number;             // running total for analytics
  cycleResetAt: Date;                // next monthly reset timestamp
}

export interface CreditBalance {
  included: number;
  purchased: number;
  total: number;                     // included + purchased
  usedThisCycle: number;
  cycleResetAt: string;              // ISO string for API responses
}

export interface CreditBundle {
  credits: number;
  price: number;                     // USD
  stripePriceId: string | null;
}

export interface CreditCheckout {
  checkoutUrl: string;
}

// ─── SMS Message Types ───────────────────────────────────────────

export type SmsDeliveryStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'undelivered'
  | 'failed'
  | 'received'         // inbound
  | 'blocked'          // blocked by allow/block list
  | 'credit_limit';    // insufficient credits

export interface SmsMmsMedia {
  url: string;
  contentType: string;
  storageUrl?: string;   // our stored copy via AttachmentStorageService
  attachmentId?: string;
}

// ─── Twilio Webhook Payloads ─────────────────────────────────────

export interface TwilioInboundSmsPayload {
  MessageSid: string;
  AccountSid: string;
  From: string;
  To: string;
  Body: string;
  NumMedia: string;      // Twilio sends as string
  NumSegments: string;
  MessagingServiceSid?: string;
  FromCity?: string;
  FromState?: string;
  FromZip?: string;
  FromCountry?: string;
  ToCity?: string;
  ToState?: string;
  ToZip?: string;
  ToCountry?: string;
  // MMS media — dynamic keys: MediaUrl0, MediaUrl1, ..., MediaContentType0, ...
  [key: string]: string | undefined;
}

export interface TwilioStatusCallbackPayload {
  MessageSid: string;
  AccountSid: string;
  From: string;
  To: string;
  MessageStatus: string;
  ErrorCode?: string;
  ErrorMessage?: string;
  MessagingServiceSid?: string;
}
