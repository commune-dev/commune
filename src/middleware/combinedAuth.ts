import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getCollection } from '../db';
import { ApiKeyService } from '../services/apiKeyService';
import type { User } from '../types';
import logger from '../utils/logger';

export interface AuthenticatedRequest extends Request {
  user?: User;
  orgId?: string;
  apiKey?: string;
  apiKeyData?: { permissions: string[]; orgId: string; id: string; name: string };
  authType?: 'jwt' | 'apikey';
}

const JWT_SECRET = process.env.JWT_SECRET || '';
if (!process.env.JWT_SECRET) {
  logger.error('JWT_SECRET environment variable is not set — JWT auth will reject all tokens');
}

// Short-lived user cache so repeated requests from the same authenticated user
// skip the DB lookup. 60s TTL matches typical request bursts while ensuring
// revoked/deactivated users are locked out within a minute.
const USER_CACHE_TTL_MS = 60_000;
const userCache = new Map<string, { user: User; expiresAt: number }>();

/**
 * Combined auth middleware — tries JWT first, then API key.
 * Used on /api/* dashboard routes that accept both auth methods.
 */
export const combinedAuth = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.substring(7);

    // Try JWT first (skip if secret not configured)
    if (JWT_SECRET) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET) as any;
        const userId: string = decoded.userId;

        const cachedUser = userCache.get(userId);
        if (cachedUser && cachedUser.expiresAt > Date.now()) {
          req.user = cachedUser.user;
          req.orgId = cachedUser.user.orgId;
          req.authType = 'jwt';
          return next();
        }

        const userCollection = await getCollection<User>('users');

        if (userCollection) {
          const user = await userCollection.findOne({
            id: userId,
            status: 'active',
            emailVerified: true
          });

          if (user) {
            userCache.set(userId, { user, expiresAt: Date.now() + USER_CACHE_TTL_MS });
            req.user = user;
            req.orgId = user.orgId;
            req.authType = 'jwt';
            return next();
          }
        }
      } catch (jwtError) {
        // JWT invalid — fall through to API key auth
      }
    }

    // Try API key
    const apiKeyResult = await ApiKeyService.validateApiKey(token);
    
    if (apiKeyResult) {
      req.orgId = apiKeyResult.orgId;
      req.apiKey = token;
      req.apiKeyData = {
        permissions: apiKeyResult.apiKey.permissions || [],
        orgId: apiKeyResult.orgId,
        id: apiKeyResult.apiKey.id,
        name: apiKeyResult.apiKey.name,
      };
      req.authType = 'apikey';
      return next();
    }

    return res.status(401).json({ error: 'Invalid or expired credentials' });
  } catch (error) {
    logger.error('Combined auth error', { error });
    return res.status(500).json({ error: 'Authentication error' });
  }
};
