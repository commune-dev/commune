import { Router } from 'express';
import { jwtAuth, AuthenticatedRequest } from '../../middleware/jwtAuth';
import { OrganizationService } from '../../services/organizationService';
import { getCollection } from '../../db';
import logger from '../../utils/logger';

const router = Router();

router.use(jwtAuth);

router.post('/', async (req: AuthenticatedRequest, res) => {
  try {
    const { name, slug, settings } = req.body;
    const userId = req.user!.id;
    const currentOrgId = req.orgId;

    if (!name || !slug) {
      return res.status(400).json({ error: 'Name and slug are required' });
    }

    // Check if user already has a non-temp organization
    if (currentOrgId && !currentOrgId.startsWith('org-')) {
      const existingOrg = await OrganizationService.getOrganization(currentOrgId);
      if (existingOrg) {
        return res.status(400).json({ error: 'Organization already exists' });
      }
    }

    const org = await OrganizationService.createOrganization({
      name,
      slug,
      settings
    });

    // Update user with the new organization
    const userCollection = await getCollection('users');
    if (userCollection) {
      await userCollection.updateOne(
        { id: userId },
        { $set: { orgId: org.id } }
      );
    }

    res.status(201).json({
      organization: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        settings: org.settings
      }
    });
  } catch (error) {
    logger.error('Organization creation error:', { error });
    res.status(400).json({ error: 'Failed to create organization' });
  }
});

router.get('/current', async (req: AuthenticatedRequest, res) => {
  try {
    const orgId = req.orgId!;
    const org = await OrganizationService.getOrganization(orgId);

    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    res.json({
      organization: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        settings: org.settings
      }
    });
  } catch (error) {
    logger.error('Organization fetch error:', { error });
    res.status(500).json({ error: 'Failed to fetch organization' });
  }
});

router.patch('/current', async (req: AuthenticatedRequest, res) => {
  try {
    const orgId = req.orgId!;
    const { name, slug } = req.body;

    if (!name && !slug) {
      return res.status(400).json({ error: 'Name or slug is required' });
    }

    const updates: Record<string, string> = {};
    if (name) updates.name = name;
    if (slug) updates.slug = slug;

    const org = await OrganizationService.updateOrganization(orgId, updates);
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    res.json({
      organization: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        settings: org.settings
      }
    });
  } catch (error) {
    logger.error('Organization update error:', { error });
    res.status(400).json({ error: 'Failed to update organization' });
  }
});

router.get('/', async (req: AuthenticatedRequest, res) => {
  try {
    const organizations = await OrganizationService.listOrganizations();
    res.json({ organizations });
  } catch (error) {
    logger.error('Organization list error:', { error });
    res.status(500).json({ error: 'Failed to list organizations' });
  }
});

export default router;
