import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getCollection } from '../db';
import type { User } from '../types';
import logger from '../utils/logger';

export interface AuthenticatedRequest extends Request {
  user?: User;
  orgId?: string;
}

const JWT_SECRET = process.env.JWT_SECRET || '';
if (!process.env.JWT_SECRET) {
  logger.error('🚨 SECURITY: JWT_SECRET not set in jwtAuth — JWT verification will fail');
}

// Short-lived user cache so repeated requests from the same authenticated user
// skip the DB lookup. 60s TTL matches typical request bursts while ensuring
// revoked/deactivated users are locked out within a minute.
const USER_CACHE_TTL_MS = 60_000;
const userCache = new Map<string, { user: User; expiresAt: number }>();

export const jwtAuth = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    const userId: string = decoded.userId;

    const cachedUser = userCache.get(userId);
    if (cachedUser && cachedUser.expiresAt > Date.now()) {
      req.user = cachedUser.user;
      req.orgId = cachedUser.user.orgId;
      return next();
    }

    const userCollection = await getCollection<User>('users');
    if (!userCollection) {
      return res.status(500).json({ error: 'Database error' });
    }

    const user = await userCollection.findOne({
      id: userId,
      status: 'active',
      emailVerified: true
    });

    if (!user) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }

    userCache.set(userId, { user, expiresAt: Date.now() + USER_CACHE_TTL_MS });
    req.user = user;
    req.orgId = user.orgId;
    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    logger.error('JWT authentication error:', { error });
    return res.status(500).json({ error: 'Authentication error' });
  }
};
