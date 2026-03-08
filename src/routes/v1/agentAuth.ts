import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { AgentIdentityService } from '../../services/agentIdentityService';
import logger from '../../utils/logger';

const router = Router();

// 5 registrations per IP per day — each requires a unique keypair + completing a
// contextual reasoning challenge, making mass registration expensive for scripts.
const registerRateLimit = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many registration attempts. Try again tomorrow.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// 10 challenge-verify attempts per IP per 15 minutes
const verifyRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many verification attempts.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * POST /v1/auth/agent-register
 *
 * Agent sends its public key, a description of its purpose, and org details.
 * Returns agentSignupToken + a contextual natural-language challenge.
 *
 * The challenge is NOT an opaque nonce to sign directly. It is a paragraph of
 * instructions requiring the agent to:
 *   1. Identify the primary verb of its stated purpose
 *   2. Count words in its purpose with 5+ alphabetical characters
 *   3. Include a server-issued epoch marker
 *   ...and construct a "verb:count:epochMarker" response string to sign.
 *
 * This design means a hardcoded script cannot complete registration — it requires
 * reading comprehension and contextual reasoning about the agent's own purpose.
 *
 * Body:
 *   agentName:    string — display name for this agent
 *   agentPurpose: string — 1–3 sentences describing what the agent does (20–2000 chars)
 *   orgName:      string — organization name
 *   orgSlug:      string — unique slug (becomes inbox localPart: slug@commune.email)
 *   publicKey:    string — base64-encoded raw 32-byte Ed25519 public key
 */
router.post('/agent-register', registerRateLimit, async (req: Request, res: Response) => {
  const { agentName, agentPurpose, orgName, orgSlug, publicKey } = req.body;

  if (!agentName || !agentPurpose || !orgName || !orgSlug || !publicKey) {
    return res.status(400).json({
      error: 'missing_fields',
      message: 'Required: agentName, agentPurpose, orgName, orgSlug, publicKey',
    });
  }

  // agentPurpose: 20–2000 characters, at least 3 words
  if (typeof agentPurpose !== 'string' || agentPurpose.trim().length < 20 || agentPurpose.trim().length > 2000) {
    return res.status(400).json({
      error: 'invalid_agent_purpose',
      message: 'agentPurpose must be between 20 and 2000 characters describing what your agent does',
    });
  }
  if (agentPurpose.trim().split(/\s+/).length < 3) {
    return res.status(400).json({
      error: 'invalid_agent_purpose',
      message: 'agentPurpose must contain at least 3 words',
    });
  }

  // Base64 of exactly 32 bytes = 43 data chars + 1 trailing '=' = 44 chars total
  if (typeof publicKey !== 'string' || publicKey.length !== 44 || !/^[A-Za-z0-9+/]{43}=$/.test(publicKey)) {
    return res.status(400).json({
      error: 'invalid_public_key',
      message: 'publicKey must be a base64-encoded 32-byte Ed25519 public key (44 characters, standard base64 with trailing =)',
    });
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(orgSlug)) {
    return res.status(400).json({
      error: 'invalid_org_slug',
      message: 'orgSlug may only contain letters, numbers, hyphens, and underscores',
    });
  }

  try {
    const result = await AgentIdentityService.registerAgent({
      agentName: agentName.trim(),
      agentPurpose: agentPurpose.trim(),
      orgName: orgName.trim(),
      orgSlug: orgSlug.trim().toLowerCase(),
      publicKey,
    });

    return res.status(201).json({
      agentSignupToken: result.agentSignupToken,
      challenge: result.challenge,
      instructions: [
        'Read the challenge.text carefully — it contains tasks you must complete.',
        'Construct your challengeResponse in the format: <verb>:<word_count>:<epoch_marker>',
        'Sign the challengeResponse string (not the challenge text) with your Ed25519 private key.',
        'Submit both to POST /v1/auth/agent-verify.',
      ],
      expiresIn: 900,
    });
  } catch (err: any) {
    if (err.code === 'INVALID_PUBLIC_KEY') {
      return res.status(400).json({ error: 'invalid_public_key', message: err.message });
    }
    if (err.message?.includes('Organization slug already exists') || err.message?.includes('slug')) {
      return res.status(409).json({ error: 'slug_exists', message: 'This org slug is already taken' });
    }
    logger.error('Agent registration error', { err });
    return res.status(500).json({ error: 'registration_failed', message: 'Registration failed' });
  }
});

/**
 * POST /v1/auth/agent-verify
 *
 * Agent submits the challengeResponse it constructed from the challenge text,
 * plus an Ed25519 signature of that challengeResponse string.
 *
 * Server validates:
 *   1. challengeResponse format: "verb:count:epochMarker"
 *   2. word count matches the pre-computed count for the agent's stated purpose
 *   3. epoch marker matches what was issued
 *   4. signature is a valid Ed25519 sig of challengeResponse (not the challenge text)
 *
 * On success: activates account, auto-provisions inbox, returns agentId + inboxEmail.
 *
 * Body:
 *   agentSignupToken:  string — from the /agent-register response
 *   challengeResponse: string — the "verb:count:epochMarker" string you constructed
 *   signature:         string — base64 Ed25519 signature of challengeResponse
 */
router.post('/agent-verify', verifyRateLimit, async (req: Request, res: Response) => {
  const { agentSignupToken, challengeResponse, signature } = req.body;

  if (!agentSignupToken || !challengeResponse || !signature) {
    return res.status(400).json({
      error: 'missing_fields',
      message: 'Required: agentSignupToken, challengeResponse, signature',
    });
  }

  if (typeof challengeResponse !== 'string') {
    return res.status(400).json({
      error: 'invalid_challenge_response',
      message: 'challengeResponse must be a string in the format: verb:count:epochMarker',
    });
  }

  if (typeof signature !== 'string') {
    return res.status(400).json({
      error: 'invalid_signature_format',
      message: 'signature must be a base64-encoded Ed25519 signature of your challengeResponse string',
    });
  }

  try {
    const result = await AgentIdentityService.verifyAgentChallenge({
      agentSignupToken,
      challengeResponse,
      signature,
    });

    return res.status(200).json({
      agentId: result.agentId,
      orgId: result.orgId,
      inboxEmail: result.inboxEmail,
      message: [
        'Registration complete. Store these permanently:',
        `  export COMMUNE_AGENT_ID="${result.agentId}"`,
        '  export COMMUNE_PRIVATE_KEY="<your_private_key_base64>"',
        '',
        `Your inbox is ready: ${result.inboxEmail}`,
        'Sign every request: Authorization: Agent {COMMUNE_AGENT_ID}:{ed25519_signature}',
      ].join('\n'),
    });
  } catch (err: any) {
    if (err.code === 'INVALID_TOKEN') {
      return res.status(401).json({ error: 'invalid_token', message: 'Invalid or expired signup token' });
    }
    if (err.code === 'INVALID_CHALLENGE_RESPONSE') {
      return res.status(400).json({ error: 'invalid_challenge_response', message: err.message });
    }
    if (err.code === 'INVALID_SIGNATURE') {
      return res.status(401).json({ error: 'invalid_signature', message: err.message });
    }
    logger.error('Agent challenge verification error', { err });
    return res.status(500).json({ error: 'verification_failed', message: 'Verification failed' });
  }
});

export default router;
