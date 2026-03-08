// ─── Voice Calling Types ──────────────────────────────────────────

export type VoiceCallStatus =
  | 'initiating'
  | 'ringing'
  | 'in-progress'
  | 'completed'
  | 'failed'
  | 'busy'
  | 'no-answer';

export type VoiceGender = 'alloy' | 'ash' | 'ballad' | 'cedar' | 'coral' | 'echo' | 'marin' | 'sage' | 'shimmer' | 'verse';

// ─── Tool ─────────────────────────────────────────────────────────

export interface ToolWebhookImpl {
  type: 'webhook';
  url: string;           // https:// only (SSRF-validated at save time AND execution time)
  method: 'POST' | 'GET';
  headers?: Record<string, string>;
  webhookSecret: string; // encrypted at rest with ENCRYPTION_KEY; shown ONCE at creation
  timeoutMs: number;     // default 8000, max 30000
  retries: number;       // default 1
}

export interface Tool {
  id: string;            // tl_xxxxx
  orgId: string;

  // OpenAI function schema — what the model sees
  name: string;          // /^[a-zA-Z0-9_]{1,64}$/ enforced at save
  description: string;   // max 1024 chars; include WHEN to call, when NOT to call
  parameters: Record<string, unknown>; // JSON Schema object

  // What Commune executes when the model calls this tool
  implementation: ToolWebhookImpl;

  // Version: increment on name/description/parameters/url change
  version: number;

  createdAt: Date;
  updatedAt: Date;
  lastTestedAt?: Date;
  lastTestResult?: 'success' | 'failure';
  lastTestDurationMs?: number;
}

// ─── VoiceAgent (per phone number config) ─────────────────────────

export interface VoiceTurnDetection {
  type: 'server_vad';    // always server_vad for phone audio (semantic_vad unreliable at 8kHz)
  threshold?: number;           // default 0.5
  prefixPaddingMs?: number;     // default 300
  silenceDurationMs?: number;   // default 500
  idleTimeoutMs: number;        // default 10000 — fires timeout event after N ms silence
  createResponse: boolean;      // default true
  interruptResponse: boolean;   // default true
}

export interface VoiceAgent {
  id: string;            // va_xxxxx
  orgId: string;
  phoneNumberId: string; // unique — one agent config per phone number

  // OpenAI session config
  systemPrompt: string;  // max 16000 chars (OpenAI instruction limit ~16384 tokens including tools)
  voice: VoiceGender;    // default "marin"
  firstMessage?: string; // spoken immediately on outbound call answer

  // Tool references — ordered list of which tools this number can use
  toolIds: string[];     // refs to tools collection (by id: tl_xxxxx)

  // VAD config
  turnDetection: VoiceTurnDetection;

  // Call behavior
  maxCallDurationSeconds: number;  // default 600, max 3600
  recordingEnabled: boolean;       // Twilio recording (NOT OpenAI — data not retained by OpenAI)

  createdAt: Date;
  updatedAt: Date;
}

// ─── Call ─────────────────────────────────────────────────────────

export interface TranscriptEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  itemId: string;        // OpenAI conversation item ID
}

export interface ToolCallLogEntry {
  toolId: string;
  toolName: string;
  toolVersion: number;
  callId: string;        // OpenAI tool call_id from response.output_item.done
  arguments: Record<string, unknown>;
  result?: string;       // JSON string (may be error JSON)
  durationMs?: number;
  success: boolean;
  error?: string;
  timestamp: Date;
}

export interface Call {
  id: string;            // call_xxxxx
  orgId: string;
  phoneNumberId: string;
  voiceAgentId: string;

  // Twilio identifiers
  callSid: string;       // CA... (set immediately from calls.create response)
  streamSid?: string;    // MZ... (set when Twilio opens the media stream WebSocket)

  // Security — one-time nonce for WS upgrade auth (expire after first use)
  wsNonce: string;
  wsNonceUsed: boolean;

  direction: 'outbound' | 'inbound';
  to: string;            // E.164
  from: string;          // E.164

  status: VoiceCallStatus;

  startedAt?: Date;      // when Twilio reports call answered
  answeredAt?: Date;     // when media stream first connects (WS start event)
  endedAt?: Date;
  durationSeconds?: number;

  // Call content — assembled in-memory, flushed on end
  transcript: TranscriptEntry[];
  toolCallLog: ToolCallLogEntry[];

  // Credits
  creditsReserved: number;
  creditsCharged?: number;

  // Post-call
  webhookDelivered?: boolean;
  webhookDeliveredAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

// ─── API request/response types ───────────────────────────────────

export interface CreateCallParams {
  to: string;            // E.164
  phoneNumberId: string;
  // Per-call overrides (optional)
  systemPromptOverride?: string;
  maxDurationSeconds?: number;
  machineDetection?: 'Enable' | 'DetectMessageEnd';  // answering machine detection
}

export interface CreateToolParams {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  webhookUrl: string;
  webhookMethod?: 'POST' | 'GET';
  webhookHeaders?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
}

export interface CreateToolResponse {
  tool: Omit<Tool, 'implementation'> & {
    implementation: Omit<ToolWebhookImpl, 'webhookSecret'>;
  };
  webhookSecret: string;  // shown ONCE at creation, never again
}

export interface SetVoiceAgentParams {
  systemPrompt: string;
  voice?: VoiceGender;
  firstMessage?: string;
  toolIds?: string[];
  maxCallDurationSeconds?: number;
  idleTimeoutMs?: number;
  recordingEnabled?: boolean;
}

// ─── Internal bridge types ────────────────────────────────────────

export interface CallContext {
  callId: string;
  orgId: string;
  to: string;
  from: string;
  voiceAgentId: string;
  tools: Array<Tool & { implementation: ToolWebhookImpl }>;
}

// ─── Twilio voice webhook payloads ───────────────────────────────

export interface TwilioVoiceStatusPayload {
  CallSid: string;
  AccountSid: string;
  From: string;
  To: string;
  CallStatus: 'queued' | 'initiated' | 'ringing' | 'in-progress' | 'completed' | 'busy' | 'no-answer' | 'failed' | 'canceled';
  Direction: 'inbound' | 'outbound-api';
  CallDuration?: string;
  Duration?: string;
  Timestamp?: string;
  AnsweredBy?: 'human' | 'machine_start' | 'machine_end_beep' | 'machine_end_silence' | 'machine_end_other' | 'fax' | 'unknown';
  SipResponseCode?: string;
}
