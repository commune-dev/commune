import express, { Router } from 'express';
import { randomUUID } from 'crypto';
import crypto from 'crypto';
import domainStore from '../../stores/domainStore';
import { inboxLimiter } from '../../middleware/rateLimiter';
import { requireFeature, requireInboxQuota } from '../../middleware/planGate';
import logger from '../../utils/logger';
import { OrganizationService } from '../../services/organizationService';
import { getOrgTierLimits, TierType } from '../../config/rateLimits';
import { DEFAULT_DOMAIN_ID, DEFAULT_DOMAIN_NAME } from '../../config/freeTierConfig';

const router = Router();

router.get('/domains/:domainId/inboxes', async (req, res) => {
  const { domainId } = req.params;
  const orgId = (req as any).apiKey?.orgId || null;
  if (!orgId) {
    return res.status(403).json({ error: 'Organization not found for API key' });
  }
  const inboxes = await domainStore.listInboxes(domainId, orgId);
  return res.json({ data: inboxes });
});

router.post('/domains/:domainId/inboxes', inboxLimiter, requireInboxQuota, express.json(), async (req, res) => {
  const { domainId } = req.params;
  const orgId = (req as any).apiKey?.orgId || null;
  if (!orgId) {
    return res.status(403).json({ error: 'Organization not found for API key' });
  }

  try {
    const org = await OrganizationService.getOrganization(orgId);
    if (!org) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    // Restrict free tier to default domain only
    if (org.tier === 'free' && domainId !== DEFAULT_DOMAIN_ID) {
      logger.warn('Free tier attempted non-default domain', { 
        orgId, 
        orgName: org.name,
        attemptedDomainId: domainId,
        allowedDomainId: DEFAULT_DOMAIN_ID 
      });
      return res.status(403).json({ 
        error: `Free tier can only use default domain: ${DEFAULT_DOMAIN_NAME}` 
      });
    }

    let domain = await domainStore.getDomain(domainId);
    if (domain && domainId === DEFAULT_DOMAIN_ID && domain.name !== DEFAULT_DOMAIN_NAME) {
      domain = await domainStore.upsertDomain({
        ...domain,
        id: DEFAULT_DOMAIN_ID,
        name: DEFAULT_DOMAIN_NAME,
        status: domain.status || 'verified',
      });
    }
    if (!domain && org.tier === 'free' && domainId === DEFAULT_DOMAIN_ID) {
      domain = await domainStore.upsertDomain({
        id: DEFAULT_DOMAIN_ID,
        name: DEFAULT_DOMAIN_NAME,
        status: 'verified',
        createdAt: new Date().toISOString(),
        inboxes: [],
      });
    }
    if (!domain) {
      return res.status(404).json({ error: 'Domain not found' });
    }

    const { localPart, displayName, display_name, agent, webhook, status } = req.body || {};
    if (!localPart) {
      return res.status(400).json({ error: 'Missing localPart' });
    }

    const resolvedDisplayName = displayName || display_name || undefined;

    const inbox = await domainStore.upsertInbox({
      domainId,
      orgId,
      inbox: {
        id: randomUUID(),
        localPart,
        displayName: resolvedDisplayName,
        agent: agent || (resolvedDisplayName ? { name: resolvedDisplayName } : undefined),
        webhook,
        status,
      },
    });

    if (!inbox) {
      logger.warn('Inbox creation returned null (domain/org mismatch)', { orgId, domainId });
      return res.status(403).json({ error: 'Cannot create inbox on this domain' });
    }

    logger.info('Inbox created', { 
      orgId, 
      tier: org.tier,
      inboxLocalPart: localPart, 
      address: `${localPart}@${domain.name}`,
      hasWebhook: !!webhook,
      domainId 
    });

    return res.json({ data: inbox });
  } catch (err) {
    logger.error('Inbox creation exception', { orgId, error: err });
    return res.status(500).json({ error: 'Failed to create inbox' });
  }
});

router.get('/domains/:domainId/inboxes/:inboxId', async (req, res) => {
  const { domainId, inboxId } = req.params;
  const orgId = (req as any).apiKey?.orgId || null;
  if (!orgId) {
    return res.status(403).json({ error: 'Organization not found for API key' });
  }
  const inbox = await domainStore.getInbox(domainId, inboxId, orgId);
  if (!inbox) {
    return res.status(404).json({ error: 'Inbox not found' });
  }

  return res.json({ data: inbox });
});

router.put('/domains/:domainId/inboxes/:inboxId', express.json(), async (req, res) => {
  const { domainId, inboxId } = req.params;
  const orgId = (req as any).apiKey?.orgId || null;
  if (!orgId) {
    return res.status(403).json({ error: 'Organization not found for API key' });
  }
  const { localPart, agent, webhook, status } = req.body || {};
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
      localPart: localPart || existing.localPart,
      agent: agent ?? existing.agent,
      webhook: webhook ?? existing.webhook,
      status: status ?? existing.status,
    },
  });

  return res.json({ data: inbox });
});

router.delete('/domains/:domainId/inboxes/:inboxId', async (req, res) => {
  const { domainId, inboxId } = req.params;
  const orgId = (req as any).apiKey?.orgId || null;
  if (!orgId) {
    return res.status(403).json({ error: 'Organization not found for API key' });
  }
  const removed = await domainStore.removeInbox(domainId, inboxId, orgId);
  if (!removed) {
    return res.status(404).json({ error: 'Inbox not found' });
  }

  return res.json({ ok: true });
});

router.post(
  '/domains/:domainId/inboxes/:inboxId/webhook',
  express.json(),
  async (req, res) => {
    logger.debug('Webhook route hit', { params: req.params });
    const { domainId, inboxId } = req.params;
    const orgId = (req as any).apiKey?.orgId || null;
    if (!orgId) {
      return res.status(403).json({ error: 'Organization not found for API key' });
    }
    const { endpoint, events, secret } = req.body || {};
    if (!endpoint) {
      return res.status(400).json({ error: 'Missing endpoint' });
    }

    const inbox = await domainStore.updateInboxWebhook({
      domainId,
      inboxId,
      webhook: {
        endpoint,
        events,
        secret,
      },
      orgId,
    });

    if (!inbox) {
      return res.status(404).json({ error: 'Inbox not found' });
    }

    return res.json({ data: inbox });
  }
);

router.put(
  '/domains/:domainId/inboxes/:inboxId/extraction-schema',
  requireFeature('structuredExtraction'),
  express.json(),
  async (req, res) => {
    const { domainId, inboxId } = req.params;
    const orgId = (req as any).apiKey?.orgId || null;
    if (!orgId) {
      return res.status(403).json({ error: 'Organization not found for API key' });
    }

    const { name, description, schema, enabled } = req.body || {};
    
    if (!name || !schema) {
      return res.status(400).json({ error: 'Missing required fields: name and schema' });
    }

    // Validate schema is a valid JSON object
    if (typeof schema !== 'object' || Array.isArray(schema)) {
      return res.status(400).json({ error: 'Schema must be a valid JSON object' });
    }

    // Validate schema has required JSON Schema fields
    if (schema.type !== 'object' || !schema.properties) {
      return res.status(400).json({ 
        error: 'Schema must be a valid JSON Schema with type: "object" and properties' 
      });
    }

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

    logger.info('Extraction schema updated for inbox', {
      orgId,
      domainId,
      inboxId,
      schemaName: name,
      enabled: inbox?.extractionSchema?.enabled
    });

    return res.json({ data: inbox });
  }
);

router.delete(
  '/domains/:domainId/inboxes/:inboxId/extraction-schema',
  async (req, res) => {
    const { domainId, inboxId } = req.params;
    const orgId = (req as any).apiKey?.orgId || null;
    if (!orgId) {
      return res.status(403).json({ error: 'Organization not found for API key' });
    }

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

    logger.info('Extraction schema removed from inbox', {
      orgId,
      domainId,
      inboxId
    });

    return res.json({ data: inbox });
  }
);

// ─── Per-inbox manual limits (paid plans only) ──────────────────

router.get(
  '/domains/:domainId/inboxes/:inboxId/limits',
  async (req, res) => {
    const { domainId, inboxId } = req.params;
    const orgId = (req as any).apiKey?.orgId || null;
    if (!orgId) return res.status(403).json({ error: 'Organization not found' });

    const inbox = await domainStore.getInbox(domainId, inboxId, orgId);
    if (!inbox) return res.status(404).json({ error: 'Inbox not found' });

    const org = await OrganizationService.getOrganization(orgId);
    const tier = (org?.tier || 'free') as TierType;
    const tierLimits = getOrgTierLimits(tier);

    return res.json({
      data: {
        manual_limits: inbox.limits || null,
        plan_defaults: {
          emailsPerInboxPerDay: tierLimits.emailsPerInboxPerDay,
        },
        effective: {
          emailsPerDay: inbox.limits?.emailsPerDay
            ? Math.min(inbox.limits.emailsPerDay, tierLimits.emailsPerInboxPerDay)
            : tierLimits.emailsPerInboxPerDay,
        },
      },
    });
  }
);

router.put(
  '/domains/:domainId/inboxes/:inboxId/limits',
  requireFeature('manualLimits'),
  express.json(),
  async (req, res) => {
    const { domainId, inboxId } = req.params;
    const orgId = (req as any).apiKey?.orgId || null;
    if (!orgId) return res.status(403).json({ error: 'Organization not found' });

    const { emailsPerDay, emailsPerHour } = req.body || {};

    if (emailsPerDay !== undefined && (typeof emailsPerDay !== 'number' || emailsPerDay < 1)) {
      return res.status(400).json({ error: 'emailsPerDay must be a positive number' });
    }
    if (emailsPerHour !== undefined && (typeof emailsPerHour !== 'number' || emailsPerHour < 1)) {
      return res.status(400).json({ error: 'emailsPerHour must be a positive number' });
    }

    const existing = await domainStore.getInbox(domainId, inboxId, orgId);
    if (!existing) return res.status(404).json({ error: 'Inbox not found' });

    const limits: { emailsPerDay?: number; emailsPerHour?: number } = {};
    if (emailsPerDay !== undefined) limits.emailsPerDay = emailsPerDay;
    if (emailsPerHour !== undefined) limits.emailsPerHour = emailsPerHour;

    const inbox = await domainStore.upsertInbox({
      domainId,
      orgId,
      inbox: { ...existing, id: inboxId, limits },
    });

    logger.info('Inbox limits updated', { orgId, domainId, inboxId, limits });
    return res.json({ data: inbox });
  }
);

router.delete(
  '/domains/:domainId/inboxes/:inboxId/limits',
  requireFeature('manualLimits'),
  async (req, res) => {
    const { domainId, inboxId } = req.params;
    const orgId = (req as any).apiKey?.orgId || null;
    if (!orgId) return res.status(403).json({ error: 'Organization not found' });

    const existing = await domainStore.getInbox(domainId, inboxId, orgId);
    if (!existing) return res.status(404).json({ error: 'Inbox not found' });

    const inbox = await domainStore.upsertInbox({
      domainId,
      orgId,
      inbox: { ...existing, id: inboxId, limits: undefined },
    });

    logger.info('Inbox limits removed', { orgId, domainId, inboxId });
    return res.json({ data: inbox });
  }
);

// ─── SSRF protection helpers ──────────────────────────────────────

function isPrivateOrRestrictedUrl(urlString: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return true; // unparseable URL is blocked
  }

  // Only HTTPS is allowed
  if (parsed.protocol !== 'https:') return true;

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost variants
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;

  // Block link-local / metadata
  if (hostname === '169.254.169.254' || hostname.endsWith('.169.254.169.254')) return true;

  // Block Railway-internal hostnames
  if (hostname.endsWith('.railway.internal') || hostname === 'railway.internal') return true;

  // Block RFC-1918 private ranges
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (a === 10) return true;                             // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;     // 172.16.0.0/12
    if (a === 192 && b === 168) return true;               // 192.168.0.0/16
    if (a === 127) return true;                            // 127.0.0.0/8 loopback
  }

  return false;
}

// ─── Dashboard webhook test ───────────────────────────────────────

/**
 * POST /api/domains/:domainId/inboxes/:inboxId/webhook-test
 * Fire a synthetic message.received event to an inbox's configured webhook.
 * Accepts both JWT (dashboard users) and API key auth via combinedAuth.
 */
router.post(
  '/domains/:domainId/inboxes/:inboxId/webhook-test',
  express.json(),
  async (req, res) => {
    const { domainId, inboxId } = req.params;
    const orgId = (req as any).apiKey?.orgId || null;
    if (!orgId) {
      return res.status(403).json({ error: 'Organization not found' });
    }

    try {
      // Verify inbox exists and belongs to this org/domain
      const inbox = await domainStore.getInbox(domainId, inboxId, orgId);
      if (!inbox) {
        return res.status(404).json({ error: 'Inbox not found' });
      }

      // Check webhook is configured
      if (!inbox.webhook?.endpoint) {
        return res.status(400).json({ error: 'No webhook URL configured for this inbox' });
      }

      const endpoint = inbox.webhook.endpoint;

      // SSRF protection — only allow HTTPS, block private/loopback/metadata IPs
      if (isPrivateOrRestrictedUrl(endpoint)) {
        return res.status(400).json({ error: 'Webhook endpoint must be a public HTTPS URL' });
      }

      const webhookSecret = inbox.webhook.secret;
      const { event_type = 'message.received' } = req.body || {};

      // Build a realistic synthetic message.received payload
      const now = new Date().toISOString();
      const testMessageId = `test_msg_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const testThreadId = `test_thread_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const inboxAddress = inbox.address || (inbox.localPart ? `${inbox.localPart}@example.com` : 'test@example.com');

      const syntheticPayload: Record<string, any> = {
        domainId,
        inboxId: inbox.id,
        inboxAddress,
        event: {
          type: 'email.received',
          data: {
            email_id: `test_email_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
          },
        },
        email: {
          from: 'test-sender@example.com',
          to: [inboxAddress],
          subject: '[Test] Webhook verification from Commune',
          text: 'This is a synthetic test event sent by Commune to verify your webhook endpoint is working correctly.',
          html: '<p>This is a synthetic test event sent by Commune to verify your webhook endpoint is working correctly.</p>',
          message_id: testMessageId,
          created_at: now,
          headers: {
            'message-id': `<${testMessageId}@test.commune.email>`,
            'x-commune-test': 'true',
          },
        },
        message: {
          message_id: testMessageId,
          thread_id: testThreadId,
          channel: 'email',
          direction: 'inbound',
          participants: [
            { role: 'sender', identity: 'test-sender@example.com' },
            { role: 'to', identity: inboxAddress },
          ],
          content: 'This is a synthetic test event sent by Commune to verify your webhook endpoint is working correctly.',
          content_html: '<p>This is a synthetic test event sent by Commune to verify your webhook endpoint is working correctly.</p>',
          attachments: [],
          created_at: now,
          metadata: {
            created_at: now,
            subject: '[Test] Webhook verification from Commune',
            inbox_id: inbox.id,
            inbox_address: inboxAddress,
            spam_checked: true,
            spam_score: 0,
            spam_action: 'accept',
            spam_flagged: false,
            prompt_injection_checked: true,
            prompt_injection_detected: false,
            prompt_injection_risk: 'none',
          },
        },
        attachments: [],
        security: {
          spam: {
            checked: true,
            score: 0,
            action: 'accept',
            flagged: false,
          },
          prompt_injection: {
            checked: true,
            detected: false,
            risk_level: 'none',
            confidence: 0,
          },
        },
        test: true,
      };

      // Build signed headers — same format as real delivery
      const body = JSON.stringify(syntheticPayload);
      const timestamp = Date.now().toString();

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-commune-delivery-id': `test_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        'x-commune-timestamp': timestamp,
        'x-commune-attempt': '1',
        'x-commune-test': 'true',
      };

      if (webhookSecret) {
        const signature = `v1=${crypto
          .createHmac('sha256', webhookSecret)
          .update(`${timestamp}.${body}`, 'utf8')
          .digest('hex')}`;
        headers['x-commune-signature'] = signature;
      }

      // Fire with 10-second timeout
      const start = Date.now();
      let statusCode: number | null = null;
      let delivered = false;
      let errorMessage: string | null = null;

      try {
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });

        clearTimeout(timeoutHandle);
        statusCode = response.status;
        delivered = response.ok;

        if (!response.ok) {
          let responseBody = '';
          try {
            responseBody = (await response.text()).slice(0, 500);
          } catch { /* ignore */ }
          errorMessage = `HTTP ${response.status}: ${responseBody || response.statusText}`;
        }
      } catch (fetchErr: any) {
        errorMessage = fetchErr.name === 'AbortError'
          ? 'Timeout after 10000ms'
          : fetchErr.message || 'Connection failed';
      }

      const responseTimeMs = Date.now() - start;

      logger.info('Dashboard webhook test fired', {
        orgId,
        inboxId: inbox.id,
        endpoint,
        delivered,
        statusCode,
        responseTimeMs,
      });

      return res.json({
        data: {
          delivered,
          status_code: statusCode,
          response_time_ms: responseTimeMs,
          endpoint,
          event_type,
          test: true,
          ...(errorMessage && { error: errorMessage }),
        },
      });
    } catch (err) {
      logger.error('Dashboard webhook test exception', { orgId, inboxId, error: err });
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
