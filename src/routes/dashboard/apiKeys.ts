import { Router } from 'express';
import { jwtAuth, AuthenticatedRequest } from '../../middleware/jwtAuth';
import { ApiKeyService } from '../../services/apiKeyService';
import { requireFeature } from '../../middleware/planGate';
import logger from '../../utils/logger';

const router = Router();

router.use(jwtAuth);

router.post('/', async (req: AuthenticatedRequest, res) => {
  try {
    const { name, permissions, expiresIn, limits, isAdmin } = req.body;
    const userId = req.user!.id;
    const orgId = req.orgId!;

    if (!name) {
      return res.status(400).json({ error: 'API key name is required' });
    }

    const keyCount = await ApiKeyService.countApiKeysByOrg(orgId);
    if (keyCount >= 10) {
      return res.status(400).json({ error: 'Maximum API keys limit reached (10)' });
    }

    const result = await ApiKeyService.generateApiKey({
      orgId,
      name,
      permissions,
      expiresIn,
      createdBy: userId,
      isAdmin: typeof isAdmin === 'boolean' ? isAdmin : undefined,
    });

    res.status(201).json({
      apiKey: result.apiKey,
      apiKeyData: {
        id: result.apiKeyData.id,
        name: result.apiKeyData.name,
        keyPrefix: result.apiKeyData.keyPrefix,
        permissions: result.apiKeyData.permissions,
        status: result.apiKeyData.status,
        expiresAt: result.apiKeyData.expiresAt,
        createdAt: result.apiKeyData.createdAt,
        isAdmin: result.apiKeyData.isAdmin ?? null,
      }
    });
  } catch (error) {
    logger.error('API key creation error', { error });
    res.status(400).json({ error: 'Failed to create API key' });
  }
});

router.get('/', async (req: AuthenticatedRequest, res) => {
  try {
    const orgId = req.orgId!;
    const apiKeys = await ApiKeyService.listApiKeys(orgId);

    res.json({
      apiKeys: apiKeys.map(key => ({
        id: key.id,
        name: key.name,
        keyPrefix: key.keyPrefix,
        permissions: key.permissions,
        status: key.status,
        lastUsedAt: key.lastUsedAt,
        expiresAt: key.expiresAt,
        createdAt: key.createdAt,
        isAdmin: key.isAdmin ?? null,
      }))
    });
  } catch (error) {
    logger.error('API key listing error', { error });
    res.status(500).json({ error: 'Failed to list API keys' });
  }
});

router.get('/:keyId', async (req: AuthenticatedRequest, res) => {
  try {
    const { keyId } = req.params;
    const orgId = req.orgId!;

    const apiKey = await ApiKeyService.getApiKeyById(keyId);
    if (!apiKey || apiKey.orgId !== orgId) {
      return res.status(404).json({ error: 'API key not found' });
    }

    res.json({
      apiKey: {
        id: apiKey.id,
        name: apiKey.name,
        keyPrefix: apiKey.keyPrefix,
        permissions: apiKey.permissions,
        status: apiKey.status,
        lastUsedAt: apiKey.lastUsedAt,
        expiresAt: apiKey.expiresAt,
        createdAt: apiKey.createdAt,
        updatedAt: apiKey.updatedAt,
        isAdmin: apiKey.isAdmin ?? null,
      }
    });
  } catch (error) {
    logger.error('API key fetch error', { error });
    res.status(500).json({ error: 'Failed to fetch API key' });
  }
});

router.delete('/:keyId', async (req: AuthenticatedRequest, res) => {
  try {
    const { keyId } = req.params;
    const orgId = req.orgId!;

    const success = await ApiKeyService.revokeApiKey(orgId, keyId);
    if (!success) {
      return res.status(404).json({ error: 'API key not found' });
    }

    res.json({ message: 'API key revoked successfully' });
  } catch (error) {
    logger.error('API key revocation error', { error });
    res.status(500).json({ error: 'Failed to revoke API key' });
  }
});

router.post('/:keyId/rotate', async (req: AuthenticatedRequest, res) => {
  try {
    const { keyId } = req.params;
    const userId = req.user!.id;
    const orgId = req.orgId!;

    const result = await ApiKeyService.rotateApiKey(orgId, keyId, userId);
    if (!result) {
      return res.status(404).json({ error: 'API key not found' });
    }

    res.json({
      apiKey: result.apiKey,
      apiKeyData: {
        id: result.apiKeyData.id,
        name: result.apiKeyData.name,
        keyPrefix: result.apiKeyData.keyPrefix,
        permissions: result.apiKeyData.permissions,
        status: result.apiKeyData.status,
        expiresAt: result.apiKeyData.expiresAt,
        updatedAt: result.apiKeyData.updatedAt,
        isAdmin: result.apiKeyData.isAdmin ?? null,
      }
    });
  } catch (error) {
    logger.error('API key rotation error', { error });
    res.status(500).json({ error: 'Failed to rotate API key' });
  }
});

// ─── Per-API-key limits (paid plans only) ────────────────────────

router.put('/:keyId/limits', requireFeature('manualLimits'), async (req: AuthenticatedRequest, res) => {
  try {
    const { keyId } = req.params;
    const orgId = req.orgId!;
    const { maxInboxes, maxEmailsPerDay } = req.body || {};

    if (maxInboxes !== undefined && (typeof maxInboxes !== 'number' || maxInboxes < 1)) {
      return res.status(400).json({ error: 'maxInboxes must be a positive number' });
    }
    if (maxEmailsPerDay !== undefined && (typeof maxEmailsPerDay !== 'number' || maxEmailsPerDay < 1)) {
      return res.status(400).json({ error: 'maxEmailsPerDay must be a positive number' });
    }

    const apiKey = await ApiKeyService.getApiKeyById(keyId);
    if (!apiKey || apiKey.orgId !== orgId) {
      return res.status(404).json({ error: 'API key not found' });
    }

    const limits: { maxInboxes?: number; maxEmailsPerDay?: number } = {};
    if (maxInboxes !== undefined) limits.maxInboxes = maxInboxes;
    if (maxEmailsPerDay !== undefined) limits.maxEmailsPerDay = maxEmailsPerDay;

    await ApiKeyService.updateApiKeyLimits(keyId, orgId, limits);

    res.json({ message: 'API key limits updated', limits });
  } catch (error) {
    logger.error('API key limits update error', { error });
    res.status(500).json({ error: 'Failed to update API key limits' });
  }
});

router.delete('/:keyId/limits', requireFeature('manualLimits'), async (req: AuthenticatedRequest, res) => {
  try {
    const { keyId } = req.params;
    const orgId = req.orgId!;

    const apiKey = await ApiKeyService.getApiKeyById(keyId);
    if (!apiKey || apiKey.orgId !== orgId) {
      return res.status(404).json({ error: 'API key not found' });
    }

    await ApiKeyService.updateApiKeyLimits(keyId, orgId, undefined);

    res.json({ message: 'API key limits removed' });
  } catch (error) {
    logger.error('API key limits removal error', { error });
    res.status(500).json({ error: 'Failed to remove API key limits' });
  }
});

export default router;
