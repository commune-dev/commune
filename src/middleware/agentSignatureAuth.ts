import { Request, Response, NextFunction } from 'express';
import { AgentIdentityService } from '../services/agentIdentityService';
import { ApiKeyService } from '../services/apiKeyService';
import logger from '../utils/logger';

export interface V1AuthenticatedRequest extends Request {
  orgId?: string;
  agentId?: string;
  apiKey?: string;
  apiKeyData?: {
    permissions: string[];
    orgId: string;
    id: string;
    name: string;
    scope?: 'master' | 'phone';
    phoneNumberIds?: string[];
    limits?: { maxInboxes?: number; maxEmailsPerDay?: number; maxSmsPerDay?: number };
    isAdmin?: boolean;
  };
  authType?: 'apikey' | 'agent';
}

const TIMESTAMP_TOLERANCE_MS = 60_000;

/**
 * Combined auth middleware for all /v1/* routes (except /v1/auth/*).
 *
 * Accepts two formats:
 *   Authorization: Bearer comm_xxx...        → existing API key auth (unchanged)
 *   Authorization: Agent agt_xxx:base64sig   → new Ed25519 agent signature auth
 *
 * Both paths attach req.orgId and req.authType before calling next().
 */
export const v1CombinedAuth = async (
  req: V1AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return;
  }

  // --- Path 1: API Key (Bearer comm_xxx) ---
  if (authHeader.startsWith('Bearer ')) {
    const apiKey = authHeader.substring(7);
    try {
      const result = await ApiKeyService.validateApiKey(apiKey);
      if (!result) {
        res.status(401).json({ error: 'Invalid or expired API key' });
        return;
      }
      req.orgId = result.orgId;
      req.apiKey = apiKey;
      req.apiKeyData = {
        permissions: result.apiKey.permissions || [],
        orgId: result.orgId,
        id: result.apiKey.id,
        name: result.apiKey.name,
        scope: result.apiKey.scope,
        phoneNumberIds: result.apiKey.phoneNumberIds,
        limits: result.apiKey.limits,
        isAdmin: result.apiKey.isAdmin,
      };
      req.authType = 'apikey';
      next();
      return;
    } catch (err) {
      logger.error('API key auth error', { err });
      res.status(500).json({ error: 'Authentication error' });
      return;
    }
  }

  // --- Path 2: Agent Signature (Agent agt_xxx:base64sig) ---
  if (authHeader.startsWith('Agent ')) {
    const parts = authHeader.substring(6).split(':');
    if (parts.length !== 2) {
      res.status(401).json({
        error: 'invalid_authorization_format',
        message: 'Expected: Authorization: Agent {agentId}:{base64_signature}',
      });
      return;
    }

    const [agentId, signatureBase64] = parts;

    // Validate X-Commune-Timestamp header
    const tsHeader = req.headers['x-commune-timestamp'];
    if (!tsHeader || Array.isArray(tsHeader)) {
      res.status(400).json({
        error: 'missing_timestamp_header',
        message: 'X-Commune-Timestamp header required (Unix milliseconds)',
      });
      return;
    }

    const timestampMs = parseInt(tsHeader, 10);
    if (isNaN(timestampMs)) {
      res.status(400).json({ error: 'invalid_timestamp', message: 'X-Commune-Timestamp must be a Unix millisecond timestamp' });
      return;
    }

    // Quick pre-check before hitting the DB
    const drift = Math.abs(Date.now() - timestampMs);
    if (drift > TIMESTAMP_TOLERANCE_MS) {
      res.status(401).json({
        error: 'timestamp_out_of_range',
        message: `Timestamp drift of ${drift}ms exceeds ±60s. Check your system clock.`,
        serverTime: Date.now(),
      });
      return;
    }

    try {
      const result = await AgentIdentityService.verifyRequestSignature(agentId, timestampMs, signatureBase64);
      if (!result) {
        res.status(401).json({ error: 'invalid_signature', message: 'Signature verification failed' });
        return;
      }
      req.orgId = result.orgId;
      req.agentId = result.agentId;
      req.authType = 'agent';

      // Add server time to response headers (helps agents debug clock drift)
      res.setHeader('X-Commune-Server-Time', String(Date.now()));

      next();
      return;
    } catch (err) {
      logger.error('Agent signature auth error', { err });
      res.status(500).json({ error: 'Authentication error' });
      return;
    }
  }

  res.status(401).json({
    error: 'invalid_authorization_format',
    message: 'Use: Authorization: Bearer {comm_api_key}  or  Authorization: Agent {agentId}:{signature}',
  });
};
