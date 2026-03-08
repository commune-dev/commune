import { Router } from 'express';
import logger from '../../utils/logger';
import domainService from '../../services/domainService';
import domainStore from '../../stores/domainStore';
import { connect, setupCollections } from '../../db';
import { OrganizationService } from '../../services/organizationService';
import messageStore from '../../stores/messageStore';
import apiKeyStore from '../../stores/apiKeyStore';
import orgStore from '../../stores/orgStore';
import userStore from '../../stores/userStore';
import sessionStore from '../../stores/sessionStore';
import verificationStore from '../../stores/verificationStore';
import suppressionStore from '../../stores/suppressionStore';
import deliveryEventStore from '../../stores/deliveryEventStore';
import alertStore from '../../stores/alertStore';

const router = Router();

const requireAdmin = (req: any, res: any, next: any) => {
  const user = req.user;
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  return next();
};

router.use(requireAdmin);

router.post('/clear/all', async (req, res) => {
  const confirm = req.body?.confirm;
  if (confirm !== 'CLEAR_ALL_DATA') {
    return res.status(400).json({ error: 'Missing confirmation phrase' });
  }

  const db = await connect();
  if (!db) {
    return res.status(500).json({ error: 'Database not available' });
  }

  await db.dropDatabase();

  await Promise.all([
    messageStore.ensureIndexes().catch(() => null),
    apiKeyStore.ensureIndexes().catch(() => null),
    orgStore.ensureIndexes().catch(() => null),
    userStore.ensureIndexes().catch(() => null),
    sessionStore.ensureIndexes().catch(() => null),
    verificationStore.ensureIndexes().catch(() => null),
    suppressionStore.ensureIndexes().catch(() => null),
    deliveryEventStore.ensureIndexes().catch(() => null),
    alertStore.ensureIndexes().catch(() => null),
  ]);

  return res.json({ data: { ok: true } });
});

router.post('/migrate/domains', async (_req, res) => {
  const { data, error } = await domainService.listDomains();
  if (error) {
    return res.status(400).json({ error });
  }

  const list = data?.data || [];
  const updated: Array<{ id: string; name: string }> = [];

  for (const domain of list) {
    if (!domain.id || !domain.name) {
      continue;
    }
    await domainStore.upsertDomain({
      id: domain.id,
      name: domain.name,
      status: domain.status,
      region: domain.region,
    });

    const inboxes = await domainStore.listInboxes(domain.id);
    for (const inbox of inboxes) {
      if (!inbox.address) {
        await domainStore.upsertInbox({
          domainId: domain.id,
          inbox: {
            ...inbox,
            address: `${inbox.localPart}@${domain.name}`,
          },
        });
      }
    }

    updated.push({ id: domain.id, name: domain.name });
  }

  return res.json({ data: updated });
});

router.post('/migrate/auth', async (req, res) => {
  try {
    const db = await connect();
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    logger.info('Setting up new collections and indexes...');
    await setupCollections(db);

    logger.info('Creating default organization for existing data...');
    const defaultOrg = await OrganizationService.createOrganization({
      name: 'Default Organization',
      slug: 'default',
      settings: {
        emailVerificationRequired: false,
        maxApiKeys: 100,
        maxUsers: 50
      }
    });

    logger.info('Migrating existing domains to default organization...');
    const domainsCollection = db.collection('domains');
    const result = await domainsCollection.updateMany(
      { orgId: { $exists: false } },
      { $set: { orgId: defaultOrg.id } }
    );

    res.json({
      success: true,
      message: 'Migration completed successfully',
      data: {
        organizationId: defaultOrg.id,
        domainsMigrated: result.modifiedCount
      }
    });
  } catch (error) {
    logger.error('Migration error:', { error });
    res.status(500).json({
      error: 'Migration failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

router.get('/migrate/status', async (req, res) => {
  try {
    const db = await connect();
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);

    res.json({
      success: true,
      data: {
        collections: collectionNames,
        hasOrganizations: collectionNames.includes('organizations'),
        hasUsers: collectionNames.includes('users'),
        hasApiKeys: collectionNames.includes('api_keys'),
        hasEmailVerificationTokens: collectionNames.includes('email_verification_tokens'),
        hasSessions: collectionNames.includes('sessions')
      }
    });
  } catch (error) {
    logger.error('Status check error:', { error });
    res.status(500).json({
      error: 'Status check failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
