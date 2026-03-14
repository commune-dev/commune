import { Router, json } from 'express';
import domainService from '../../services/domainService';
import domainStore from '../../stores/domainStore';
import { requirePermission } from '../../middleware/permissions';
import { requireDomainQuota } from '../../middleware/planGate';
import { domainRateLimiter } from '../../lib/redisRateLimiter';
import { getOrgTierLimits, TierType } from '../../config/rateLimits';
import { OrganizationService } from '../../services/organizationService';
import { DEFAULT_DOMAIN_ID } from '../../config/freeTierConfig';
import logger from '../../utils/logger';
import type { DomainEntry } from '../../types';

const router = Router();

const sanitizeDomain = (domain: DomainEntry | null) => {
  if (!domain) return null;
  const { webhook, _id, orgId, ...rest } = domain as any;
  return rest;
};

/**
 * GET /v1/domains
 * List all domains for the authenticated organization.
 */
router.get('/', requirePermission('domains:read'), async (req: any, res) => {
  const orgId = req.orgId;
  try {
    const domains = await domainStore.listDomains(orgId);
    res.set('Cache-Control', 'private, max-age=30, stale-while-revalidate=60');
    return res.json({
      data: domains.map(sanitizeDomain),
    });
  } catch (err) {
    logger.error('v1: Failed to list domains', { orgId, error: err });
    return res.status(500).json({ error: 'Failed to list domains' });
  }
});

/**
 * POST /v1/domains
 * Create a new custom domain.
 * Body: { name: string, region?: string }
 */
router.post('/', json(), requireDomainQuota, domainRateLimiter, requirePermission('domains:write'), async (req: any, res) => {
  const orgId = req.orgId;
  const { name, region } = req.body || {};

  if (!name) {
    return res.status(400).json({ error: 'Missing required field: name' });
  }

  try {
    // Enforce max custom domain count per tier
    const org = await OrganizationService.getOrganization(orgId);
    if (org) {
      const tier = (org.tier || 'free') as TierType;
      const tierLimits = getOrgTierLimits(tier);
      if (tierLimits.maxCustomDomains !== Infinity) {
        const existingDomains = await domainStore.listDomains(orgId);
        const customDomainCount = existingDomains.filter(d => d.id !== DEFAULT_DOMAIN_ID).length;
        if (customDomainCount >= tierLimits.maxCustomDomains) {
          return res.status(403).json({
            error: `Custom domain limit reached (${customDomainCount}/${tierLimits.maxCustomDomains}). Upgrade your plan for more.`,
            current_count: customDomainCount,
            limit: tierLimits.maxCustomDomains,
            current_tier: tier,
            upgrade_url: '/dashboard/billing',
          });
        }
      }
    }

    const { data, entry, error } = await domainService.createDomain({
      name,
      region,
      orgId,
    });

    if (error) {
      return res.status(400).json({ error });
    }

    logger.info('v1: Domain created', { orgId, name });
    return res.status(201).json({ data: sanitizeDomain(entry) || data });
  } catch (err) {
    logger.error('v1: Domain creation failed', { orgId, error: err });
    return res.status(500).json({ error: 'Failed to create domain' });
  }
});

/**
 * GET /v1/domains/:domainId
 * Get details for a single domain.
 */
router.get('/:domainId', requirePermission('domains:read'), async (req: any, res) => {
  const { domainId } = req.params;
  const orgId = req.orgId;

  try {
    const stored = await domainStore.getDomain(domainId);
    if (!stored || (stored.orgId && stored.orgId !== orgId)) {
      return res.status(404).json({ error: 'Domain not found' });
    }
    return res.json({ data: sanitizeDomain(stored) });
  } catch (err) {
    logger.error('v1: Failed to get domain', { orgId, domainId, error: err });
    return res.status(500).json({ error: 'Failed to get domain' });
  }
});

/**
 * POST /v1/domains/:domainId/verify
 * Trigger DNS verification for a domain.
 */
router.post('/:domainId/verify', requirePermission('domains:write'), async (req: any, res) => {
  const { domainId } = req.params;
  const orgId = req.orgId;

  try {
    const stored = await domainStore.getDomain(domainId);
    if (!stored || (stored.orgId && stored.orgId !== orgId)) {
      return res.status(404).json({ error: 'Domain not found' });
    }

    const { data, error } = await domainService.verifyDomain(domainId);
    if (error) {
      return res.status(400).json({ error });
    }

    await domainService.refreshDomainRecords(domainId);
    return res.json({ data });
  } catch (err) {
    logger.error('v1: Domain verification failed', { orgId, domainId, error: err });
    return res.status(500).json({ error: 'Failed to verify domain' });
  }
});

/**
 * GET /v1/domains/:domainId/records
 * Get DNS records required for domain verification.
 */
router.get('/:domainId/records', requirePermission('domains:read'), async (req: any, res) => {
  const { domainId } = req.params;
  const orgId = req.orgId;

  try {
    const stored = await domainStore.getDomain(domainId);
    if (!stored || (stored.orgId && stored.orgId !== orgId)) {
      return res.status(404).json({ error: 'Domain not found' });
    }

    const { data, error } = await domainService.getDomain(domainId);
    if (error || !data) {
      return res.status(404).json({ error: error || 'Domain not found' });
    }

    return res.json({ data: data.records || [] });
  } catch (err) {
    logger.error('v1: Failed to get domain records', { orgId, domainId, error: err });
    return res.status(500).json({ error: 'Failed to get domain records' });
  }
});

export default router;
