import { Request, Response, NextFunction } from 'express';

/**
 * Permission scopes for API keys.
 * Legacy 'read'/'write' map to all :read/:write scopes respectively.
 */
export const PERMISSION_SCOPES = [
  'domains:read',
  'domains:write',
  'inboxes:read',
  'inboxes:write',
  'threads:read',
  'threads:write',
  'messages:read',
  'messages:write',
  'attachments:read',
  'attachments:write',
  'phoneNumbers:read',
  'phoneNumbers:write',
  'sms:read',
  'sms:write',
] as const;

export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

const LEGACY_READ_SCOPES: PermissionScope[] = [
  'domains:read',
  'inboxes:read',
  'threads:read',
  'messages:read',
  'attachments:read',
  'phoneNumbers:read',
  'sms:read',
];

const LEGACY_WRITE_SCOPES: PermissionScope[] = [
  'domains:write',
  'inboxes:write',
  'threads:write',
  'messages:write',
  'attachments:write',
  'phoneNumbers:write',
  'sms:write',
];

/**
 * Expand legacy permission strings ('read', 'write') into granular scopes.
 */
export const expandPermissions = (permissions: string[]): Set<string> => {
  const expanded = new Set<string>();
  for (const perm of permissions) {
    if (perm === 'read') {
      LEGACY_READ_SCOPES.forEach((s) => expanded.add(s));
    } else if (perm === 'write') {
      LEGACY_WRITE_SCOPES.forEach((s) => expanded.add(s));
    } else {
      expanded.add(perm);
    }
  }
  return expanded;
};

/**
 * Express middleware factory that checks if the authenticated API key
 * has the required permission scope(s).
 *
 * Usage:
 *   router.get('/domains', requirePermission('domains:read'), handler)
 *   router.post('/messages/send', requirePermission('messages:write'), handler)
 */
export const requirePermission = (...scopes: PermissionScope[]) => {
  return (req: any, res: Response, next: NextFunction) => {
    // JWT-authenticated users (dashboard) bypass permission checks
    if (req.authType === 'jwt') {
      return next();
    }

    // Agent signing auth — agents are org owners (created org during registration)
    // and have full access to their own org's resources
    if (req.authType === 'agent') {
      return next();
    }

    // For API key auth, check permissions
    const apiKeyData = req.apiKeyData;
    if (!apiKeyData) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const keyPermissions = expandPermissions(apiKeyData.permissions || []);

    const hasAll = scopes.every((scope) => keyPermissions.has(scope));
    if (!hasAll) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        required: scopes,
        hint: `Your API key needs the following permission(s): ${scopes.join(', ')}`,
      });
    }

    return next();
  };
};

/**
 * Middleware that restricts an endpoint to admin API keys only.
 *
 * - JWT (dashboard) users always pass — they have their own role system.
 * - Agent signature auth always passes — agents are org owners.
 * - API keys: `isAdmin === true` OR `isAdmin === undefined` (backward compat —
 *   keys created before this field existed are treated as admin).
 *   Only keys explicitly created with `isAdmin: false` are blocked.
 */
export const requireAdminApiKey = (req: any, res: Response, next: NextFunction): void => {
  if (req.authType === 'jwt') { next(); return; }
  if (req.authType === 'agent') { next(); return; }

  const isAdmin: boolean | undefined = req.apiKeyData?.isAdmin;
  if (isAdmin === false) {
    res.status(403).json({
      error: 'admin_key_required',
      message: 'This operation requires an admin API key. Standard API keys cannot buy, release, or configure phone numbers.',
      hint: 'Create an admin API key from the dashboard to perform this action.',
    });
    return;
  }

  next();
};
