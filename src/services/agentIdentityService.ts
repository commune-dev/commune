import { verify as cryptoVerify, createPublicKey, randomBytes } from 'crypto';
import { AgentIdentityStore } from '../stores/agentIdentityStore';
import { AgentSignupStore } from '../stores/agentSignupStore';
import { OrganizationService } from './organizationService';
import { UserService } from './userService';
import domainStore from '../stores/domainStore';
import logger from '../utils/logger';
import type { ChallengeParams } from '../types/auth';

// Ed25519 SPKI DER prefix — wraps raw 32-byte public key so Node.js crypto can use it
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const TIMESTAMP_TOLERANCE_MS = 60_000; // ±60 seconds

// Default Commune shared domain — agents get orgSlug@commune.email automatically
const DEFAULT_DOMAIN_ID = process.env.DEFAULT_DOMAIN_ID || '';
const DEFAULT_DOMAIN_NAME = process.env.DEFAULT_DOMAIN_NAME || 'commune.email';

// --- Crypto helpers ---

export function isValidBase64PublicKey(publicKeyBase64: string): boolean {
  try {
    const raw = Buffer.from(publicKeyBase64, 'base64');
    return raw.length === 32;
  } catch {
    return false;
  }
}

function verifyEd25519Signature(
  publicKeyBase64: string,
  message: string,
  signatureBase64: string
): boolean {
  try {
    const rawPubKey = Buffer.from(publicKeyBase64, 'base64');
    if (rawPubKey.length !== 32) return false;

    const der = Buffer.concat([SPKI_ED25519_PREFIX, rawPubKey]);
    const publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });

    const sig = Buffer.from(signatureBase64, 'base64');
    if (sig.length !== 64) return false;

    return cryptoVerify(null, Buffer.from(message), publicKey, sig);
  } catch {
    return false;
  }
}

// --- Contextual challenge helpers ---

/**
 * Count words in a string that have 5 or more alphabetical characters.
 * Punctuation is stripped before measuring each word's length.
 *
 * "handles customer-support tickets efficiently" → ["handles"(7), "customer"(8), "support"(7), "tickets"(7), "efficiently"(11)] → 5
 */
function countLongWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter(w => w.replace(/[^a-zA-Z]/g, '').length >= 5)
    .length;
}

/**
 * Generate a contextual registration challenge for an LLM agent.
 *
 * The challenge is a natural-language paragraph — not a structured JSON nonce.
 * It requires the agent to:
 *   1. Identify the primary verb of their stated purpose (reading comprehension + reasoning)
 *   2. Count words in their purpose with 5+ alphabetical chars (reading + arithmetic)
 *   3. Include a server-issued epoch marker (prevents replay / cached solutions)
 *
 * The server pre-computes the expected word count and stores it alongside the epoch
 * marker, so verification is fully deterministic — no LLM evaluation needed server-side.
 *
 * A hardcoded script targeting Commune's API cannot complete this challenge because:
 *   - The old API expected signing an opaque "chal_xxx" nonce directly; the new flow
 *     requires constructing and signing a structured string derived from NLP reasoning.
 *   - The epoch marker is unique per registration (no caching solutions).
 *   - The verb must semantically match the stated purpose — not derivable without
 *     reading comprehension.
 *   - The word count depends on the content of agentPurpose, which varies per agent.
 */
function generateContextualChallenge(
  agentName: string,
  agentPurpose: string
): { challengeText: string; challengeParams: ChallengeParams } {
  const epochMarker = randomBytes(8).toString('hex'); // 16-char hex, unguessable
  const expectedWordCount = countLongWords(agentPurpose);

  const challengeText = [
    `You are registering "${agentName}" on Commune, an email infrastructure platform for AI agents.`,
    ``,
    `Your stated purpose:`,
    `"${agentPurpose}"`,
    ``,
    `To verify you are an AI agent capable of reading and reasoning about your own context,`,
    `complete ALL THREE of the following steps:`,
    ``,
    `STEP 1 — PRIMARY VERB`,
    `Identify the single lowercase verb that best captures your agent's core action.`,
    `Choose one that genuinely reflects what you do — for example: monitors, processes, sends,`,
    `handles, analyzes, classifies, routes, extracts, generates, summarizes, responds,`,
    `manages, detects, orchestrates, triages, filters, schedules, coordinates, validates.`,
    ``,
    `STEP 2 — WORD COUNT`,
    `Count the words in your stated purpose above that contain 5 or more alphabetical`,
    `characters. Strip punctuation before measuring each word's length. Use the exact`,
    `quoted text as your source (do not re-read this instruction text).`,
    ``,
    `STEP 3 — EPOCH MARKER`,
    `Include this exact string: ${epochMarker}`,
    ``,
    `RESPONSE FORMAT`,
    `Construct your challengeResponse as a single colon-separated string:`,
    `  <primary_verb>:<word_count>:<epoch_marker>`,
    ``,
    `Example — if your verb is "processes" and your word count is 4:`,
    `  processes:4:${epochMarker}`,
    ``,
    `Sign this exact challengeResponse string (not this challenge text) with your`,
    `Ed25519 private key. Submit both challengeResponse and signature to /v1/auth/agent-verify.`,
  ].join('\n');

  return {
    challengeText,
    challengeParams: { epochMarker, expectedWordCount },
  };
}

/**
 * Validate the agent's challengeResponse against the stored params.
 *
 * Format: "<verb>:<wordCount>:<epochMarker>"
 *
 * Validates:
 *   - Exactly 3 colon-separated parts
 *   - verb: single lowercase alphabetical word, 2–30 chars
 *   - wordCount: integer matching the server's pre-computed expectedWordCount
 *   - epochMarker: exact match to the stored epoch marker
 *
 * The verb is validated for format (lowercase alpha) but NOT for semantic correctness —
 * that would require an LLM judge. The script-resistance comes from the agent needing
 * to parse natural language to discover the required format + compute the correct count.
 */
function validateChallengeResponse(
  challengeResponse: string,
  params: ChallengeParams
): { valid: boolean; reason?: string } {
  if (!challengeResponse || typeof challengeResponse !== 'string') {
    return { valid: false, reason: 'challengeResponse is required' };
  }

  const parts = challengeResponse.split(':');
  if (parts.length !== 3) {
    return {
      valid: false,
      reason: 'challengeResponse must have exactly 3 colon-separated parts: verb:count:epochMarker',
    };
  }

  const [verb, countStr, marker] = parts;

  // Verb: single lowercase alphabetical word, 2–30 characters
  if (!/^[a-z]{2,30}$/.test(verb)) {
    return {
      valid: false,
      reason: 'first part (verb) must be a single lowercase alphabetical word, 2–30 characters',
    };
  }

  // Word count: must be a non-negative integer matching the pre-computed value
  if (!/^\d+$/.test(countStr)) {
    return { valid: false, reason: 'second part (word count) must be a non-negative integer' };
  }
  const count = parseInt(countStr, 10);
  if (count !== params.expectedWordCount) {
    return { valid: false, reason: 'word count does not match the 5+-character word count of your stated purpose' };
  }

  // Epoch marker: must be verbatim
  if (marker !== params.epochMarker) {
    return { valid: false, reason: 'epoch marker does not match — use the exact string from the challenge' };
  }

  return { valid: true };
}

// --- Service ---

export class AgentIdentityService {
  /**
   * Step 1: Agent sends public key, agent purpose, and org details.
   *
   * Creates org + synthetic user, generates a contextual natural-language challenge
   * that requires LLM reasoning to complete, stores pending signup, and returns the
   * challenge text + signup token.
   *
   * New field: agentPurpose — a 1–3 sentence description of what the agent does.
   * This is used to generate a challenge specific to the agent's context, making it
   * impossible to hardcode a solution without an LLM.
   */
  static async registerAgent(data: {
    agentName: string;
    agentPurpose: string; // new: what the agent does — used to generate contextual challenge
    orgName: string;
    orgSlug: string;
    publicKey: string;  // base64 raw 32-byte Ed25519 PUBLIC key
  }): Promise<{ agentSignupToken: string; challenge: { text: string; format: string } }> {
    const { agentName, agentPurpose, orgName, orgSlug, publicKey } = data;

    // Validate public key format before touching the DB
    if (!isValidBase64PublicKey(publicKey)) {
      throw Object.assign(new Error('publicKey must be a base64-encoded 32-byte Ed25519 public key'), { code: 'INVALID_PUBLIC_KEY' });
    }

    // Create org (slug uniqueness validated inside OrganizationService)
    const org = await OrganizationService.createOrganization({ name: orgName, slug: orgSlug });

    // Create a placeholder user — agents don't have email yet (that's why they're signing up!)
    // Synthetic email satisfies DB uniqueness; never displayed or sent to.
    const syntheticEmail = `agent_${randomBytes(12).toString('hex')}@agents.internal`;
    let user: import('../types/auth').User;
    try {
      ({ user } = await UserService.registerAgentUser({
        orgId: org.id,
        email: syntheticEmail,
        name: agentName,
      }));
    } catch (err: any) {
      logger.error('Agent user creation failed after org creation', { orgId: org.id, err: err.message });
      throw Object.assign(new Error('Registration failed'), { code: 'REGISTRATION_FAILED' });
    }

    // Generate contextual challenge — specific to this agent's purpose
    const { challengeText, challengeParams } = generateContextualChallenge(agentName, agentPurpose);

    // Store pending signup atomically — all params included so verify step needs no extra fetch
    const signup = await AgentSignupStore.create({
      agentName,
      agentPurpose,
      orgName,
      orgSlug,
      publicKey,
      challenge: challengeText,
      challengeParams,
      userId: user.id,
      orgId: org.id,
    });

    return {
      agentSignupToken: signup.agentSignupToken,
      challenge: {
        text: challengeText,
        format: '<primary_verb>:<word_count>:<epoch_marker>',
      },
    };
  }

  /**
   * Step 2: Agent submits their constructed challengeResponse and its signature.
   *
   * The agent must have:
   *   1. Read the challenge text (natural language)
   *   2. Identified their primary verb
   *   3. Counted 5+-character words in their stated purpose
   *   4. Constructed: "<verb>:<count>:<epochMarker>"
   *   5. Signed that string with their private key
   *
   * Server validates:
   *   - challengeResponse format is correct
   *   - word count matches the pre-computed expectedWordCount for their agentPurpose
   *   - epoch marker matches what was issued
   *   - signature is a valid Ed25519 signature of challengeResponse (not the challenge text)
   *
   * On success: activates account, auto-provisions inbox, returns agentId.
   */
  static async verifyAgentChallenge(data: {
    agentSignupToken: string;
    challengeResponse: string; // the agent-constructed "verb:count:epochMarker" string
    signature: string;          // base64 Ed25519 signature of challengeResponse
  }): Promise<{ agentId: string; orgId: string; inboxEmail: string }> {
    const { agentSignupToken, challengeResponse, signature } = data;

    const signup = await AgentSignupStore.findByToken(agentSignupToken);
    if (!signup) {
      throw Object.assign(new Error('Invalid or expired signup token'), { code: 'INVALID_TOKEN' });
    }

    // 1. Validate challengeResponse structure + correctness (deterministic, no LLM needed)
    const validation = validateChallengeResponse(challengeResponse, signup.challengeParams);
    if (!validation.valid) {
      throw Object.assign(
        new Error(`Challenge response invalid: ${validation.reason}`),
        { code: 'INVALID_CHALLENGE_RESPONSE' }
      );
    }

    // 2. Verify the Ed25519 signature — the agent signs challengeResponse, not the challenge text.
    //    This proves: (a) the agent holds the private key, AND (b) they constructed the correct response.
    const valid = verifyEd25519Signature(signup.publicKey, challengeResponse, signature);
    if (!valid) {
      throw Object.assign(
        new Error('Signature verification failed — ensure you signed the challengeResponse string, not the challenge text'),
        { code: 'INVALID_SIGNATURE' }
      );
    }

    const { userId, orgId, orgSlug, agentName, agentPurpose } = signup;

    // Activate user
    const { getCollection } = await import('../db');
    const userCollection = await getCollection<import('../types/auth').User>('users');
    if (!userCollection) throw new Error('Database not available');
    await userCollection.updateOne(
      { id: userId },
      { $set: { status: 'active', emailVerified: true, updatedAt: new Date().toISOString() } }
    );

    // Auto-provision inbox: orgSlug@commune.email — agent gets email in the same call
    let inboxEmail = `${orgSlug}@${DEFAULT_DOMAIN_NAME}`;
    if (DEFAULT_DOMAIN_ID) {
      try {
        const inbox = await domainStore.upsertInbox({
          domainId: DEFAULT_DOMAIN_ID,
          orgId,
          inbox: {
            localPart: orgSlug,
            displayName: agentName,
            agent: { name: agentName },
            status: 'active',
            createdAt: new Date().toISOString(),
          },
        });
        if (inbox?.address) {
          inboxEmail = inbox.address;
        }
      } catch (err) {
        // Non-fatal: agent still gets their identity even if inbox creation fails
        logger.warn('Auto-inbox provisioning failed during agent registration', { orgId, orgSlug, err });
      }
    }

    // Create permanent agent identity record (now includes agentPurpose)
    const identity = await AgentIdentityStore.create({
      agentName,
      agentPurpose,
      inboxEmail,
      publicKey: signup.publicKey,
      orgId,
      userId,
    });

    // Mark signup as verified (TTL index will auto-delete the record after expiry)
    await AgentSignupStore.markVerified(signup.id);

    logger.info('Agent identity created via contextual challenge-response', {
      agentId: identity.id,
      orgId,
      inboxEmail,
      agentPurpose: agentPurpose.slice(0, 80),
    });

    return { agentId: identity.id, orgId, inboxEmail };
  }

  /**
   * Per-request: Verify the Ed25519 signature from the Authorization header.
   * Called by the v1CombinedAuth middleware on every authenticated /v1/* request.
   *
   * Returns { orgId, agentId } if valid, null if invalid (caller returns 401).
   *
   * Unchanged from the original implementation — per-request auth is already solid.
   */
  static async verifyRequestSignature(
    agentId: string,
    timestampMs: number,
    signatureBase64: string
  ): Promise<{ orgId: string; agentId: string } | null> {
    // 1. Look up the agent's public key (only active agents).
    //    Must happen before nonce claim so a garbage-signature request from an
    //    attacker who knows a valid agentId cannot burn nonces (DoS).
    const identity = await AgentIdentityStore.findById(agentId);
    if (!identity) {
      return null;
    }

    // 2. Verify the Ed25519 signature BEFORE consuming the nonce.
    //    message = "{agentId}:{timestampMs}" — same format the agent computes client-side
    const message = `${agentId}:${timestampMs}`;
    const valid = verifyEd25519Signature(identity.publicKey, message, signatureBase64);
    if (!valid) {
      logger.warn('Agent signature verification failed', { agentId });
      return null;
    }

    // 3. Replay protection: claim this (agentId, timestampMs) nonce atomically.
    //    Only reached after the signature is confirmed valid, so only the legitimate
    //    key-holder can consume nonces.
    const nonceAccepted = await AgentIdentityStore.claimNonce(agentId, timestampMs);
    if (!nonceAccepted) {
      logger.warn('Agent request replay detected', { agentId, timestampMs });
      return null;
    }

    // 4. Update last used timestamp — fire-and-forget, don't block the request
    AgentIdentityStore.updateLastUsed(agentId).catch(err =>
      logger.error('Failed to update agent lastUsedAt', { err })
    );

    return { orgId: identity.orgId, agentId };
  }
}
