/**
 * OAuthService — "Continue with Commune"
 *
 * Commune as the OAuth identity provider (like Google for "Sign in with Google").
 *
 * Flow:
 *   1. Integrator calls POST /oauth/send-code  → Commune sends OTP to agent's inbox
 *   2. Agent reads OTP, submits it
 *   3. Integrator calls POST /oauth/verify-code → Commune returns access_token + id_token + agent_id
 *   4. Integrator uses agent_id to fetch agent claims: GET /oauth/agentinfo
 *   5. When access_token expires: POST /oauth/token (grant_type=refresh_token)
 *
 * Domain validation:
 *   Requests to send-code and verify-code must come from the registered websiteUrl domain.
 *   Localhost is always allowed (dev mode). Server-to-server calls (no Origin header) are allowed.
 */
import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import jwt from 'jsonwebtoken';
import { getCollection } from '../db';
import sesClient from './sesClient';
import { OAuthCodeStore } from '../stores/oauthCodeStore';
import { OAuthTokenStore } from '../stores/oauthTokenStore';
import { OAuthRefreshTokenStore } from '../stores/oauthRefreshTokenStore';
import { AgentIdentityStore } from '../stores/agentIdentityStore';
import type { AgentIdentity, Organization } from '../types/auth';
import type { OAuthClient } from '../stores/oauthClientStore';
import logger from '../utils/logger';

const DEFAULT_FROM = process.env.OAUTH_FROM_EMAIL
  || process.env.DEFAULT_FROM_EMAIL
  || `noreply@${process.env.DEFAULT_DOMAIN_NAME || 'commune.email'}`;

const JWT_SECRET = process.env.JWT_SECRET || '';
const COMMUNE_ISSUER = process.env.COMMUNE_OAUTH_ISSUER || 'https://commune.dev';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TrustLevel = 'new' | 'provisional' | 'established' | 'trusted';

/** The stable agent identity payload — returned to integrators. Mirrors Google's userinfo shape. */
export interface AgentInfo {
  // Standard OIDC fields (mirrors Google's naming)
  sub: string;                   // stable agent ID — "agt_xxx" — never changes
  email: string;                 // agent's Commune inbox email
  email_verified: boolean;       // always true — Commune controls the inbox
  name: string;                  // agent display name

  // Commune-specific agent fields
  entity_type: 'agent';          // always 'agent' — unambiguous for integrators
  verified_agent: boolean;       // true = passed Commune's contextual challenge at registration
  purpose: string;               // agent's stated purpose (from registration)
  registered_at: string;         // ISO 8601 — when the agent joined Commune
  account_age_days: number;
  last_active_at: string | null;

  // Operator (the company behind the agent)
  org_id: string;
  org_name: string;
  org_slug: string;
  org_tier: string;              // free | agent_pro | business | enterprise

  // Email infrastructure metrics — Commune's unique signal
  email_reputation: {
    score: number;               // 0–100 composite
    grade: 'A' | 'B' | 'C' | 'D' | 'F';
    spam_agent: boolean;
    sends_last_30d: number;
    domain_name: string;
    domain_verified: boolean;
  };

  // Trust
  trust_level: TrustLevel;      // new | provisional | established | trusted
  trust_score: number;           // 0–100
  trust_signals: string[];       // machine-readable evidence markers

  // Moltbook social profile
  moltbook_connected: boolean;
  moltbook_handle?: string;

  // Optional profile enrichment — provided by the agent at registration
  avatar_url?: string;
  website_url?: string;
  capabilities?: string[];
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  id_token: string;              // signed JWT with agent claims (like Google's id_token)
  agent_id: string;              // the stable identifier — key this in your DB (like Google's sub)
  scope: string;
}

export interface SendCodeResult {
  request_id: string;
  expires_in: number;
  email_hint: string;
}

// ─── Domain validation ────────────────────────────────────────────────────────

const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

function isLocalhost(hostname: string): boolean {
  return LOCALHOST_HOSTNAMES.has(hostname);
}

function extractHostname(urlOrOrigin: string): string | null {
  try {
    return new URL(urlOrOrigin).hostname;
  } catch {
    return null;
  }
}

/**
 * Validate that a request is coming from the integrator's registered domain.
 *
 * Rules:
 *   - Localhost → always allowed (dev mode)
 *   - Origin matches registered websiteUrl domain or its subdomains → allowed
 *   - No Origin header (server-to-server) → allowed (client_secret is the auth)
 *   - Origin present but mismatched → rejected
 *
 * Returns null on success, an error string on failure.
 */
export function validateRequestOrigin(
  originHeader: string | undefined,
  refererHeader: string | undefined,
  registeredWebsiteUrl: string | undefined
): string | null {
  // No origin headers at all → server-to-server call, allow (authenticated via client_secret)
  const rawOrigin = originHeader || refererHeader;
  if (!rawOrigin) return null;

  const requestHostname = extractHostname(rawOrigin);
  if (!requestHostname) return null; // malformed, skip validation

  // Always allow localhost (dev/test mode)
  if (isLocalhost(requestHostname)) return null;

  // No registered websiteUrl → allow (shouldn't happen after registration validation)
  if (!registeredWebsiteUrl) return null;

  const registeredHostname = extractHostname(registeredWebsiteUrl);
  if (!registeredHostname) return null;

  // Exact match or subdomain match
  if (
    requestHostname === registeredHostname ||
    requestHostname.endsWith('.' + registeredHostname)
  ) {
    return null; // allowed
  }

  return `Request origin "${requestHostname}" is not authorized for this client. ` +
    `Registered domain: "${registeredHostname}". ` +
    `For development, use localhost.`;
}

// ─── Trust score computation ──────────────────────────────────────────────────

function computeTrustScore(agentAgeDays: number, emailsSent: number): number {
  let score = 0;
  if (agentAgeDays >= 1) score += 10;
  if (agentAgeDays >= 7) score += 10;
  if (agentAgeDays >= 30) score += 15;
  if (emailsSent >= 1) score += 10;
  if (emailsSent >= 10) score += 10;
  if (emailsSent >= 50) score += 10;
  if (emailsSent >= 200) score += 10;
  if (agentAgeDays >= 1 || emailsSent > 0) score += 15; // active inbox signal
  return Math.min(100, score);
}

function scoreToLevel(score: number): TrustLevel {
  if (score <= 24) return 'new';
  if (score <= 49) return 'provisional';
  if (score <= 74) return 'established';
  return 'trusted';
}

function scoreToGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 80) return 'A';
  if (score >= 65) return 'B';
  if (score >= 50) return 'C';
  if (score >= 30) return 'D';
  return 'F';
}

function trustSignals(agentAgeDays: number, emailsSent: number): string[] {
  const signals = ['key_pair_verified', 'contextual_challenge_passed'];
  if (agentAgeDays >= 1) signals.push('inbox_age_1d');
  if (agentAgeDays >= 7) signals.push('inbox_age_7d');
  if (agentAgeDays >= 30) signals.push('inbox_age_30d');
  if (emailsSent >= 10) signals.push('inbox_activity_moderate');
  if (emailsSent >= 50) signals.push('inbox_activity_high');
  return signals;
}

function daysSince(isoDate: string): number {
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24));
}

// ─── Data fetching helpers ────────────────────────────────────────────────────

async function getOrgById(orgId: string): Promise<Organization | null> {
  const collection = await getCollection<Organization>('organizations');
  if (!collection) return null;
  return collection.findOne({ id: orgId }) as Promise<Organization | null>;
}

async function getSendCount30d(orgId: string): Promise<number> {
  try {
    const collection = await getCollection<{ orgId: string; direction: string; created_at: string }>('messages');
    if (!collection) return 0;
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    return collection.countDocuments({ orgId, direction: 'outbound', created_at: { $gte: since } });
  } catch {
    return 0;
  }
}

async function findAgentByEmail(email: string): Promise<AgentIdentity | null> {
  const collection = await getCollection<AgentIdentity>('agent_identities');
  if (!collection) return null;
  return collection.findOne({ inboxEmail: email, status: 'active' });
}

// ─── Build AgentInfo payload ──────────────────────────────────────────────────

async function buildAgentInfo(agent: AgentIdentity): Promise<AgentInfo> {
  const [org, sendCount] = await Promise.all([
    getOrgById(agent.orgId),
    getSendCount30d(agent.orgId),
  ]);

  const agentAgeDays = daysSince(agent.createdAt);
  const trustScore = computeTrustScore(agentAgeDays, sendCount);
  const inboxEmail = agent.inboxEmail || '';
  const domainName = inboxEmail.split('@')[1] || process.env.DEFAULT_DOMAIN_NAME || 'commune.email';

  return {
    sub: agent.id,
    email: inboxEmail,
    email_verified: true,
    name: agent.agentName,
    entity_type: 'agent',
    verified_agent: true,
    purpose: agent.agentPurpose,
    registered_at: agent.createdAt,
    account_age_days: agentAgeDays,
    last_active_at: agent.lastUsedAt || null,

    org_id: agent.orgId,
    org_name: (org as any)?.name || '',
    org_slug: (org as any)?.slug || '',
    org_tier: (org as any)?.tier || 'free',

    email_reputation: {
      score: trustScore,
      grade: scoreToGrade(trustScore),
      spam_agent: trustScore < 20,
      sends_last_30d: sendCount,
      domain_name: domainName,
      domain_verified: agentAgeDays > 0,
    },

    trust_level: scoreToLevel(trustScore),
    trust_score: trustScore,
    trust_signals: trustSignals(agentAgeDays, sendCount),

    moltbook_connected: !!agent.moltbookHandle,
    ...(agent.moltbookHandle && { moltbook_handle: agent.moltbookHandle }),
    ...(agent.avatarUrl && { avatar_url: agent.avatarUrl }),
    ...(agent.websiteUrl && { website_url: agent.websiteUrl }),
    ...(agent.capabilities?.length && { capabilities: agent.capabilities }),
  };
}

// ─── Sign the id_token (like Google's signed JWT) ─────────────────────────────

function signIdToken(agentInfo: AgentInfo, clientId: string): string {
  const payload = {
    iss: COMMUNE_ISSUER,
    sub: agentInfo.sub,           // stable agent_id — same value as agent_id in token response
    aud: clientId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: agentInfo.email,
    email_verified: true,
    name: agentInfo.name,
    // Commune-specific claims (namespaced to avoid conflicts)
    'commune:entity_type': 'agent',
    'commune:verified_agent': true,
    'commune:trust_level': agentInfo.trust_level,
    'commune:trust_score': agentInfo.trust_score,
    'commune:org_id': agentInfo.org_id,
    'commune:org_tier': agentInfo.org_tier,
  };
  return jwt.sign(payload, JWT_SECRET);
}

// ─── OTP email ────────────────────────────────────────────────────────────────

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const masked = local.length <= 2
    ? local[0] + '***'
    : local[0] + '***' + local[local.length - 1];
  return `${masked}@${domain}`;
}

function buildOtpEmail(code: string, integrator: string): { subject: string; html: string; text: string } {
  const subject = `${code} — your Commune verification code`;
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: monospace; max-width: 480px; margin: 40px auto; padding: 0 20px; color: #111;">
  <p style="font-size: 13px; color: #888; margin-bottom: 4px;">Commune Auth</p>
  <h2 style="margin: 0 0 20px; font-size: 20px;">Verification code</h2>
  <p style="color: #444; font-size: 14px; margin-bottom: 20px;">
    <strong>${integrator}</strong> is requesting to verify your Commune identity.
  </p>
  <div style="background: #f4f4f4; border-radius: 8px; padding: 24px; text-align: center; margin-bottom: 20px;">
    <span style="font-size: 42px; font-weight: bold; letter-spacing: 14px; font-family: monospace;">${code}</span>
  </div>
  <p style="font-size: 13px; color: #888;">Expires in <strong>10 minutes</strong>. Do not share this code.</p>
  <p style="font-size: 12px; color: #bbb; margin-top: 32px;">— Commune</p>
</body>
</html>`;
  const text = `Commune Auth\n\nVerification code for ${integrator}:\n\n  ${code}\n\nExpires in 10 minutes.\n`;
  return { subject, html, text };
}

async function sendOtpEmail(toEmail: string, code: string, integratorName: string): Promise<void> {
  const { subject, html, text } = buildOtpEmail(code, integratorName);
  await sesClient.send(new SendEmailCommand({
    Destination: { ToAddresses: [toEmail] },
    FromEmailAddress: DEFAULT_FROM,
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: html, Charset: 'UTF-8' },
          Text: { Data: text, Charset: 'UTF-8' },
        },
      },
    },
  }));
  logger.info('OAuth OTP email sent', { toEmail, integratorName });
}

// ─── Public service methods ───────────────────────────────────────────────────

export class OAuthService {
  /**
   * Step 1: Send a verification code to the agent's Commune inbox.
   */
  static async sendCode(params: {
    email: string;
    clientId: string;
    integratorName: string;
    originHeader?: string;
    refererHeader?: string;
    registeredWebsiteUrl?: string;
    ipAddress?: string;
  }): Promise<SendCodeResult> {
    const { email, clientId, integratorName, originHeader, refererHeader, registeredWebsiteUrl, ipAddress } = params;

    // Domain validation
    const domainError = validateRequestOrigin(originHeader, refererHeader, registeredWebsiteUrl);
    if (domainError) {
      throw Object.assign(new Error(domainError), { code: 'ORIGIN_NOT_ALLOWED' });
    }

    const agent = await findAgentByEmail(email);
    if (!agent) {
      throw Object.assign(new Error('No active Commune agent found for this email'), { code: 'AGENT_NOT_FOUND' });
    }

    const limited = await OAuthCodeStore.isRateLimited(email, clientId);
    if (limited) {
      throw Object.assign(
        new Error('Too many verification requests for this email. Try again in 15 minutes.'),
        { code: 'RATE_LIMITED' }
      );
    }

    const { requestId, plainCode } = await OAuthCodeStore.create({
      agentEmail: email,
      agentId: agent.id,
      orgId: agent.orgId,
      clientId,
      ipAddress,
    });

    try {
      await sendOtpEmail(email, plainCode, integratorName);
    } catch (err) {
      logger.error('Failed to send OAuth OTP email', { email, clientId, err });
      throw Object.assign(new Error('Failed to send verification code. Try again.'), { code: 'EMAIL_SEND_FAILED' });
    }

    return {
      request_id: requestId,
      expires_in: 600,
      email_hint: maskEmail(email),
    };
  }

  /**
   * Step 2: Verify the OTP and issue tokens.
   * Returns Google-style token response: access_token + id_token + refresh_token + agent_id.
   */
  static async verifyCode(params: {
    requestId: string;
    code: string;
    clientId: string;
    originHeader?: string;
    refererHeader?: string;
    registeredWebsiteUrl?: string;
  }): Promise<TokenResponse> {
    const { requestId, code, clientId, originHeader, refererHeader, registeredWebsiteUrl } = params;

    // Domain validation
    const domainError = validateRequestOrigin(originHeader, refererHeader, registeredWebsiteUrl);
    if (domainError) {
      throw Object.assign(new Error(domainError), { code: 'ORIGIN_NOT_ALLOWED' });
    }

    const otpRecord = await OAuthCodeStore.verifyAndConsume(requestId, code, clientId);
    if (!otpRecord) {
      throw Object.assign(new Error('Invalid or expired verification code'), { code: 'INVALID_CODE' });
    }

    const agent = await AgentIdentityStore.findById(otpRecord.agentId);
    if (!agent || agent.status !== 'active') {
      throw Object.assign(new Error('Agent account is no longer active'), { code: 'AGENT_INACTIVE' });
    }

    const agentInfo = await buildAgentInfo(agent as AgentIdentity);
    const idToken = signIdToken(agentInfo, clientId);

    const [{ token: accessToken }, refreshToken] = await Promise.all([
      OAuthTokenStore.create({
        agentEmail: otpRecord.agentEmail,
        agentId: agent.id,
        orgId: agent.orgId,
        clientId,
        scope: 'identity',
      }),
      OAuthRefreshTokenStore.create({
        agentEmail: otpRecord.agentEmail,
        agentId: agent.id,
        orgId: agent.orgId,
        clientId,
        scope: 'identity',
      }),
    ]);

    AgentIdentityStore.updateLastUsed(agent.id).catch(() => {});
    logger.info('OAuth verification complete', { agentId: agent.id, clientId });

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refreshToken,
      id_token: idToken,
      agent_id: agent.id,   // the stable identifier — integrators key their DB on this
      scope: 'identity',
    };
  }

  /**
   * GET /oauth/agentinfo — fetch agent claims by presenting an access token.
   * Like Google's /oauth2/v2/userinfo.
   */
  static async getAgentInfo(plainToken: string): Promise<AgentInfo> {
    const tokenRecord = await OAuthTokenStore.validate(plainToken);
    if (!tokenRecord) {
      throw Object.assign(new Error('Invalid or expired access token'), { code: 'INVALID_TOKEN' });
    }

    const agent = await AgentIdentityStore.findById(tokenRecord.agentId);
    if (!agent || agent.status !== 'active') {
      throw Object.assign(new Error('Agent account is no longer active'), { code: 'AGENT_INACTIVE' });
    }

    return buildAgentInfo(agent as AgentIdentity);
  }

  /**
   * POST /oauth/token (grant_type=refresh_token) — get a new access_token + id_token.
   * Rotates the refresh token (old one is revoked, new one is issued).
   */
  static async refreshAccessToken(params: {
    refreshToken: string;
    clientId: string;
  }): Promise<TokenResponse> {
    const { refreshToken, clientId } = params;

    const rotated = await OAuthRefreshTokenStore.rotate(refreshToken, clientId);
    if (!rotated) {
      throw Object.assign(new Error('Invalid or expired refresh token'), { code: 'INVALID_REFRESH_TOKEN' });
    }

    const agent = await AgentIdentityStore.findById(rotated.record.agentId);
    if (!agent || agent.status !== 'active') {
      throw Object.assign(new Error('Agent account is no longer active'), { code: 'AGENT_INACTIVE' });
    }

    const agentInfo = await buildAgentInfo(agent as AgentIdentity);
    const idToken = signIdToken(agentInfo, clientId);

    const { token: newAccessToken } = await OAuthTokenStore.create({
      agentEmail: rotated.record.agentEmail,
      agentId: agent.id,
      orgId: agent.orgId,
      clientId,
      scope: rotated.record.scope,
    });

    return {
      access_token: newAccessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: rotated.newToken,
      id_token: idToken,
      agent_id: agent.id,
      scope: rotated.record.scope,
    };
  }

  static async revokeToken(plainToken: string): Promise<boolean> {
    if (plainToken.startsWith('comm_refresh_')) {
      // Revoking a refresh token — revoke both the refresh and any linked access tokens
      const collection = await getCollection<{ agentId: string; clientId: string; tokenPrefix: string }>('oauth_refresh_tokens');
      if (collection) {
        const prefix = plainToken.substring(0, 25);
        const record = await collection.findOne({ tokenPrefix: prefix });
        if (record) {
          await OAuthRefreshTokenStore.revokeAllForAgent(record.agentId, record.clientId);
          await OAuthTokenStore.revokeAllForAgent(record.agentId, record.clientId);
          return true;
        }
      }
      return false;
    }
    return OAuthTokenStore.revoke(plainToken);
  }
}
