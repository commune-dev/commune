import { Router, json } from 'express';
import { randomUUID } from 'crypto';
import domainStore from '../../stores/domainStore';
import { requirePermission } from '../../middleware/permissions';
import { requireFeature, requireInboxQuota } from '../../middleware/planGate';
import { inboxRateLimiter } from '../../lib/redisRateLimiter';
import { enforceApiKeyInboxLimit } from '../../middleware/apiKeyLimits';
import { OrganizationService } from '../../services/organizationService';
import { DEFAULT_DOMAIN_ID, DEFAULT_DOMAIN_NAME } from '../../config/freeTierConfig';
import logger from '../../utils/logger';

const router = Router();

// ─── Helper: resolve domain for an org (auto-detect or default) ────────────

async function resolveDomain(orgId: string): Promise<{ domainId: string; domainName: string } | null> {
  // 1. Check if org has its own domains
  const domains = await domainStore.listDomains(orgId);
  if (domains.length > 0 && domains[0].name) {
    return { domainId: domains[0].id, domainName: domains[0].name };
  }

  // 2. No org-owned domains — use the shared default domain (auto-create if needed)
  let defaultDomain = await domainStore.getDomain(DEFAULT_DOMAIN_ID);
  if (defaultDomain) {
    // Keep stored shared default domain name in sync with env config.
    if (defaultDomain.name !== DEFAULT_DOMAIN_NAME) {
      defaultDomain = await domainStore.upsertDomain({
        ...defaultDomain,
        id: DEFAULT_DOMAIN_ID,
        name: DEFAULT_DOMAIN_NAME,
        status: defaultDomain.status || 'verified',
      });
    }
    return { domainId: defaultDomain!.id, domainName: defaultDomain!.name || DEFAULT_DOMAIN_NAME };
  }

  // 3. Default domain doesn't exist — create it as a shared domain (no orgId)
  defaultDomain = await domainStore.upsertDomain({
    id: DEFAULT_DOMAIN_ID,
    name: DEFAULT_DOMAIN_NAME,
    status: 'verified',
    createdAt: new Date().toISOString(),
    inboxes: [],
  });

  return defaultDomain
    ? { domainId: DEFAULT_DOMAIN_ID, domainName: DEFAULT_DOMAIN_NAME }
    : null;
}

// ─── Top-level inbox routes (no domain_id required) ────────────────────────

/**
 * POST /v1/inboxes
 * Create an inbox. Domain is auto-resolved if not provided.
 *
 * Body: { local_part: string, domain_id?: string, name?: string, webhook?: object }
 */
router.post('/', json(), requireInboxQuota, inboxRateLimiter, enforceApiKeyInboxLimit, requirePermission('inboxes:write'), async (req: any, res) => {
  const orgId = req.orgId;
  const { local_part, localPart, domain_id, domainId: bodyDomainId, name, display_name, displayName: bodyDisplayName, webhook, status } = req.body || {};

  const lp = local_part || localPart;
  if (!lp) {
    return res.status(400).json({ error: 'Missing required field: local_part' });
  }

  const resolvedDisplayName = display_name || bodyDisplayName || name || undefined;

  try {
    let domainId = domain_id || bodyDomainId;
    let domainName: string | undefined;

    if (domainId) {
      // Explicit domain — verify it exists
      const domain = await domainStore.getDomain(domainId);
      if (!domain) {
        return res.status(404).json({ error: 'Domain not found' });
      }
      domainName = domain.name;
    } else {
      // Auto-resolve domain
      const resolved = await resolveDomain(orgId);
      if (!resolved) {
        return res.status(500).json({ error: 'Could not resolve a domain for your organization' });
      }
      domainId = resolved.domainId;
      domainName = resolved.domainName;
    }

    const inbox = await domainStore.upsertInbox({
      domainId,
      orgId,
      inbox: {
        id: randomUUID(),
        localPart: lp,
        displayName: resolvedDisplayName,
        agent: name ? { name } : undefined,
        webhook,
        status,
      },
    });

    if (!inbox) {
      return res.status(403).json({ error: 'Cannot create inbox on this domain' });
    }

    logger.info('v1: Inbox created (auto-resolve)', { orgId, domainId, localPart: lp, address: `${lp}@${domainName}` });
    return res.status(201).json({
      data: {
        ...inbox,
        domain_id: domainId,
        domain_name: domainName,
      },
    });
  } catch (err) {
    logger.error('v1: Inbox creation failed', { orgId, error: err });
    return res.status(500).json({ error: 'Failed to create inbox' });
  }
});

/**
 * GET /v1/inboxes
 * List all inboxes for the org (across all domains).
 */
router.get('/', requirePermission('inboxes:read'), async (req: any, res) => {
  const orgId = req.orgId;

  try {
    const [domains, defaultInboxes] = await Promise.all([
      domainStore.listDomains(orgId),
      domainStore.listInboxes(DEFAULT_DOMAIN_ID, orgId),
    ]);

    // Fetch all custom-domain inboxes in parallel
    const customInboxArrays = await Promise.all(
      domains.map((domain) =>
        domainStore
          .listInboxes(domain.id, orgId)
          .then((inboxes) => inboxes.map((inbox) => ({ ...inbox, domain_id: domain.id, domain_name: domain.name })))
      )
    );
    const allInboxes: any[] = customInboxArrays.flat();

    // Add default domain inboxes if not already included
    const domainIds = new Set(domains.map((d) => d.id));
    if (!domainIds.has(DEFAULT_DOMAIN_ID)) {
      for (const inbox of defaultInboxes) {
        allInboxes.push({ ...inbox, domain_id: DEFAULT_DOMAIN_ID, domain_name: DEFAULT_DOMAIN_NAME });
      }
    }

    res.set('Cache-Control', 'private, max-age=30, stale-while-revalidate=60');
    return res.json({ data: allInboxes });
  } catch (err) {
    logger.error('v1: Failed to list all inboxes', { orgId, error: err });
    return res.status(500).json({ error: 'Failed to list inboxes' });
  }
});

// ─── Domain-nested inbox routes (explicit domain_id) ───────────────────────

/**
 * GET /v1/domains/:domainId/inboxes
 * List all inboxes for a domain.
 */
router.get('/:domainId/inboxes', requirePermission('inboxes:read'), async (req: any, res) => {
  const { domainId } = req.params;
  const orgId = req.orgId;

  try {
    const inboxes = await domainStore.listInboxes(domainId, orgId);
    return res.json({ data: inboxes });
  } catch (err) {
    logger.error('v1: Failed to list inboxes', { orgId, domainId, error: err });
    return res.status(500).json({ error: 'Failed to list inboxes' });
  }
});

/**
 * POST /v1/domains/:domainId/inboxes
 * Create a new inbox.
 * Body: { local_part: string, name?: string, webhook?: { endpoint: string, events?: string[] } }
 */
router.post('/:domainId/inboxes', json(), requireInboxQuota, inboxRateLimiter, enforceApiKeyInboxLimit, requirePermission('inboxes:write'), async (req: any, res) => {
  const { domainId } = req.params;
  const orgId = req.orgId;
  const { local_part, localPart, name, display_name, displayName: bodyDisplayName, webhook, status } = req.body || {};

  const lp = local_part || localPart;
  if (!lp) {
    return res.status(400).json({ error: 'Missing required field: local_part' });
  }

  const resolvedDisplayName = display_name || bodyDisplayName || name || undefined;

  try {
    const domain = await domainStore.getDomain(domainId);
    if (!domain) {
      return res.status(404).json({ error: 'Domain not found' });
    }

    const inbox = await domainStore.upsertInbox({
      domainId,
      orgId,
      inbox: {
        id: randomUUID(),
        localPart: lp,
        displayName: resolvedDisplayName,
        agent: name ? { name } : undefined,
        webhook,
        status,
      },
    });

    if (!inbox) {
      return res.status(403).json({ error: 'Cannot create inbox on this domain' });
    }

    logger.info('v1: Inbox created', { orgId, domainId, localPart: lp });
    return res.status(201).json({ data: inbox });
  } catch (err) {
    logger.error('v1: Inbox creation failed', { orgId, domainId, error: err });
    return res.status(500).json({ error: 'Failed to create inbox' });
  }
});

/**
 * GET /v1/domains/:domainId/inboxes/:inboxId
 * Get a single inbox.
 */
router.get('/:domainId/inboxes/:inboxId', requirePermission('inboxes:read'), async (req: any, res) => {
  const { domainId, inboxId } = req.params;
  const orgId = req.orgId;

  try {
    const inbox = await domainStore.getInbox(domainId, inboxId, orgId);
    if (!inbox) {
      return res.status(404).json({ error: 'Inbox not found' });
    }
    return res.json({ data: inbox });
  } catch (err) {
    logger.error('v1: Failed to get inbox', { orgId, domainId, inboxId, error: err });
    return res.status(500).json({ error: 'Failed to get inbox' });
  }
});

/**
 * PUT /v1/domains/:domainId/inboxes/:inboxId
 * Update an inbox.
 * Body: { local_part?: string, webhook?: { endpoint: string, events?: string[] }, status?: string }
 */
router.put('/:domainId/inboxes/:inboxId', json(), requirePermission('inboxes:write'), async (req: any, res) => {
  const { domainId, inboxId } = req.params;
  const orgId = req.orgId;
  const { local_part, localPart, webhook, status } = req.body || {};

  try {
    const existing = await domainStore.getInbox(domainId, inboxId, orgId);
    if (!existing) {
      return res.status(404).json({ error: 'Inbox not found' });
    }

    const inbox = await domainStore.upsertInbox({
      domainId,
      orgId,
      inbox: {
        ...existing,
        id: inboxId,
        localPart: local_part || localPart || existing.localPart,
        webhook: webhook ?? existing.webhook,
        status: status ?? existing.status,
      },
    });

    return res.json({ data: inbox });
  } catch (err) {
    logger.error('v1: Inbox update failed', { orgId, domainId, inboxId, error: err });
    return res.status(500).json({ error: 'Failed to update inbox' });
  }
});

/**
 * DELETE /v1/domains/:domainId/inboxes/:inboxId
 * Delete an inbox.
 */
router.delete('/:domainId/inboxes/:inboxId', requirePermission('inboxes:write'), async (req: any, res) => {
  const { domainId, inboxId } = req.params;
  const orgId = req.orgId;

  try {
    const removed = await domainStore.removeInbox(domainId, inboxId, orgId);
    if (!removed) {
      return res.status(404).json({ error: 'Inbox not found' });
    }
    return res.json({ data: { ok: true } });
  } catch (err) {
    logger.error('v1: Inbox deletion failed', { orgId, domainId, inboxId, error: err });
    return res.status(500).json({ error: 'Failed to delete inbox' });
  }
});

/**
 * PUT /v1/domains/:domainId/inboxes/:inboxId/extraction-schema
 * Configure structured extraction for an inbox.
 * Body: { name: string, description?: string, schema: object, enabled?: boolean }
 */
router.put(
  '/:domainId/inboxes/:inboxId/extraction-schema',
  json(),
  requirePermission('inboxes:write'),
  requireFeature('structuredExtraction'),
  async (req: any, res) => {
    const { domainId, inboxId } = req.params;
    const orgId = req.orgId;
    const { name, description, schema, enabled } = req.body || {};

    if (!name || !schema) {
      return res.status(400).json({ error: 'Missing required fields: name and schema' });
    }
    if (typeof schema !== 'object' || Array.isArray(schema)) {
      return res.status(400).json({ error: 'Schema must be a valid JSON object' });
    }
    if (schema.type !== 'object' || !schema.properties) {
      return res.status(400).json({
        error: 'Schema must be a valid JSON Schema with type: "object" and properties',
      });
    }

    try {
      const existing = await domainStore.getInbox(domainId, inboxId, orgId);
      if (!existing) {
        return res.status(404).json({ error: 'Inbox not found' });
      }

      const inbox = await domainStore.upsertInbox({
        domainId,
        orgId,
        inbox: {
          ...existing,
          id: inboxId,
          extractionSchema: {
            name,
            description,
            schema,
            enabled: enabled !== undefined ? enabled : true,
          },
        },
      });

      logger.info('v1: Extraction schema updated for inbox', {
        orgId,
        domainId,
        inboxId,
        schemaName: name,
        enabled: inbox?.extractionSchema?.enabled,
      });

      return res.json({ data: inbox });
    } catch (err) {
      logger.error('v1: Failed to update extraction schema', { orgId, domainId, inboxId, error: err });
      return res.status(500).json({ error: 'Failed to update extraction schema' });
    }
  }
);

/**
 * DELETE /v1/domains/:domainId/inboxes/:inboxId/extraction-schema
 * Remove structured extraction config from an inbox.
 */
router.delete(
  '/:domainId/inboxes/:inboxId/extraction-schema',
  requirePermission('inboxes:write'),
  async (req: any, res) => {
    const { domainId, inboxId } = req.params;
    const orgId = req.orgId;

    try {
      const existing = await domainStore.getInbox(domainId, inboxId, orgId);
      if (!existing) {
        return res.status(404).json({ error: 'Inbox not found' });
      }

      const inbox = await domainStore.upsertInbox({
        domainId,
        orgId,
        inbox: {
          ...existing,
          id: inboxId,
          extractionSchema: undefined,
        },
      });

      logger.info('v1: Extraction schema removed from inbox', { orgId, domainId, inboxId });
      return res.json({ data: inbox });
    } catch (err) {
      logger.error('v1: Failed to remove extraction schema', { orgId, domainId, inboxId, error: err });
      return res.status(500).json({ error: 'Failed to remove extraction schema' });
    }
  }
);

export default router;
