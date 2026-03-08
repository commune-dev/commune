export type OrgTier = 'free' | 'agent_pro' | 'business' | 'enterprise';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  tier: OrgTier;
  settings: {
    allowedDomains?: string[];
    emailVerificationRequired?: boolean;
    maxApiKeys?: number;
    maxUsers?: number;
  };
  status: 'active' | 'inactive' | 'suspended';
  createdAt: string;
  updatedAt: string;
  // Stripe billing
  stripe_customer_id?: string;
  stripe_subscription_id?: string;
  billing_cycle?: 'monthly' | 'yearly';
  plan_updated_at?: string;
  // Usage tracking
  attachment_storage_used_bytes?: number;
  // Phone / SMS
  twilioSubaccountSid?: string;
  twilioSubaccountAuthToken?: string; // encrypted at rest
  twilioMessagingServiceSid?: string;
  a2pStatus?: 'none' | 'brand_approved' | 'campaign_approved';
  phoneCredits?: {
    included: number;
    purchased: number;
    usedThisCycle: number;
    cycleResetAt: Date;
  };
  /**
   * Human-configurable anti-spam limits (dashboard only — not exposed to agent API).
   * When set, these override the tier defaults.
   */
  phoneSettings?: {
    maxPhoneNumbers?: number;         // override tier default (hard cap on number count)
    maxSmsPerDayPerNumber?: number;   // daily outbound limit per phone number (default: 500)
    maxSmsPerDayTotal?: number;       // daily outbound limit across all numbers (default: 2000)
    maxSmsPerMonth?: number;          // monthly outbound limit (default: 20000)
    requireHumanApprovalAbove?: number; // pause sends above this daily count pending human review
  };
}

export interface User {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: 'admin' | 'member' | 'viewer';
  status: 'active' | 'inactive' | 'pending';
  emailVerified: boolean;
  emailVerificationToken?: string;
  emailVerificationExpires?: string;
  passwordHash: string;
  provider?: 'email' | 'google';
  googleId?: string;
  avatarUrl?: string;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKey {
  id: string;
  orgId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  permissions: string[];
  status: 'active' | 'inactive' | 'expired';
  lastUsedAt?: string;
  expiresAt?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  limits?: {
    maxInboxes?: number;
    maxEmailsPerDay?: number;
    maxSmsPerDay?: number;
  };
  keyHashV2?: string;
  // Phone-scoped API keys
  scope?: 'master' | 'phone';
  phoneNumberIds?: string[];  // if scope === 'phone', restricted to these phone number IDs
  // Admin keys can buy/release phone numbers and manage security-sensitive config.
  // Absent (undefined) → treated as admin for backward compatibility.
  isAdmin?: boolean;
}

export interface EmailVerificationToken {
  id: string;
  userId: string;
  token: string;
  email: string;
  purpose: 'verification' | 'password_reset' | 'login';
  expiresAt: string;
  createdAt: string;
  usedAt?: string;
}

export interface Session {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  lastAccessAt: string;
  createdAt: string;
}

// Agent signing standard types

/**
 * Server-side parameters pre-computed at challenge generation time.
 * Stored with the pending signup so verifyAgentChallenge can validate
 * the agent's challengeResponse deterministically — no LLM needed server-side.
 */
export interface ChallengeParams {
  epochMarker: string;       // random 16-char hex string; agent must include verbatim
  expectedWordCount: number; // count of words in agentPurpose with 5+ alphabetical chars
}

export interface AgentIdentity {
  id: string;           // "agt_<32hex>" — stored as COMMUNE_AGENT_ID by the agent
  agentName: string;
  agentPurpose: string; // agent's stated purpose; used to generate contextual challenge
  inboxEmail?: string;  // auto-provisioned at registration: orgSlug@commune.email
  publicKey: string;    // base64-encoded raw 32-byte Ed25519 public key
  orgId: string;
  userId: string;
  status: 'active' | 'revoked';
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface AgentSignup {
  id: string;
  agentSignupToken: string; // opaque token returned to agent after POST /v1/auth/agent-register
  agentName: string;
  agentPurpose: string;     // agent's stated purpose; used to generate the contextual challenge
  orgName: string;
  orgSlug: string;
  publicKey: string;        // base64-encoded public key — used to verify the challengeResponse signature
  challenge: string;        // the full natural-language challenge text returned to the agent
  challengeParams: ChallengeParams; // pre-computed answer params for server-side deterministic validation
  status: 'pending' | 'verified' | 'expired';
  expiresAt: string;        // 15-minute TTL
  createdAt: string;
  // Set atomically during registerAgent so verifyAgentChallenge never needs a second DB fetch
  userId: string;
  orgId: string;
}

export interface AgentSignatureNonce {
  _id: string;    // "{agentId}:{timestampMs}" — unique constraint is the replay guard
  expiresAt: Date;
}
