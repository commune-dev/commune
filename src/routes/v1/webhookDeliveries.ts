import { Router } from 'express';
import crypto, { randomUUID } from 'crypto';
import logger from '../../utils/logger';
import webhookDeliveryStore from '../../stores/webhookDeliveryStore';
import webhookDeliveryService from '../../services/webhookDeliveryService';
import domainStore from '../../stores/domainStore';
import type { WebhookDeliveryStatus } from '../../types';
import { requirePermission } from '../../middleware/permissions';

const router = Router();

function isAllowedWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Only allow HTTPS
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    // Block localhost and loopback
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
    // Block link-local (AWS metadata service)
    if (host.startsWith('169.254.')) return false;
    // Block private IP ranges
    if (host.startsWith('10.') || host.startsWith('192.168.')) return false;
    if (host.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./)) return false;
    // Block Railway internal hostnames
    if (host.endsWith('.railway.internal')) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * GET /v1/webhooks/deliveries
 * List webhook deliveries with filters.
 */
router.get('/deliveries', requirePermission('messages:read'), async (req: any, res) => {
  try {
    const orgId = req.apiKey?.orgId || req.orgId;
    const { inbox_id, status, endpoint, limit, offset } = req.query;

    const result = await webhookDeliveryStore.listDeliveries({
      org_id: orgId,
      inbox_id: inbox_id as string,
      status: status as WebhookDeliveryStatus,
      endpoint: endpoint as string,
      limit: limit ? parseInt(limit as string, 10) : 50,
      offset: offset ? parseInt(offset as string, 10) : 0,
    });

    return res.json({
      deliveries: result.deliveries.map(d => ({
        delivery_id: d.delivery_id,
        inbox_id: d.inbox_id,
        message_id: d.message_id,
        endpoint: d.endpoint,
        status: d.status,
        attempt_count: d.attempt_count,
        max_attempts: d.max_attempts,
        created_at: d.created_at,
        delivered_at: d.delivered_at,
        dead_at: d.dead_at,
        last_error: d.last_error,
        last_status_code: d.last_status_code,
        delivery_latency_ms: d.delivery_latency_ms,
        next_retry_at: d.next_retry_at,
      })),
      total: result.total,
    });
  } catch (err: any) {
    logger.error('❌ List webhook deliveries error:', { error: err });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /v1/webhooks/deliveries/:deliveryId
 * Get full delivery detail including all attempts.
 */
router.get('/deliveries/:deliveryId', requirePermission('messages:read'), async (req: any, res) => {
  try {
    const { deliveryId } = req.params;
    const delivery = await webhookDeliveryStore.getDelivery(deliveryId);

    if (!delivery) {
      return res.status(404).json({ error: 'Delivery not found' });
    }

    // Verify org access
    const orgId = req.apiKey?.orgId || req.orgId;
    if (orgId && delivery.org_id && delivery.org_id !== orgId) {
      return res.status(404).json({ error: 'Delivery not found' });
    }

    return res.json({
      delivery: {
        delivery_id: delivery.delivery_id,
        inbox_id: delivery.inbox_id,
        message_id: delivery.message_id,
        endpoint: delivery.endpoint,
        payload_hash: delivery.payload_hash,
        status: delivery.status,
        attempts: delivery.attempts,
        attempt_count: delivery.attempt_count,
        max_attempts: delivery.max_attempts,
        created_at: delivery.created_at,
        delivered_at: delivery.delivered_at,
        dead_at: delivery.dead_at,
        last_error: delivery.last_error,
        last_status_code: delivery.last_status_code,
        delivery_latency_ms: delivery.delivery_latency_ms,
        next_retry_at: delivery.next_retry_at,
      },
    });
  } catch (err: any) {
    logger.error('❌ Get webhook delivery error:', { error: err });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /v1/webhooks/deliveries/:deliveryId/retry
 * Manually retry a dead or failed delivery.
 */
router.post('/deliveries/:deliveryId/retry', requirePermission('messages:write'), async (req: any, res) => {
  try {
    const { deliveryId } = req.params;

    // Verify the delivery exists and belongs to this org
    const delivery = await webhookDeliveryStore.getDelivery(deliveryId);
    if (!delivery) {
      return res.status(404).json({ error: 'Delivery not found' });
    }

    const orgId = req.apiKey?.orgId || req.orgId;
    if (orgId && delivery.org_id && delivery.org_id !== orgId) {
      return res.status(404).json({ error: 'Delivery not found' });
    }

    const result = await webhookDeliveryService.retryDelivery(deliveryId);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    return res.json({ ok: true, message: 'Delivery queued for retry' });
  } catch (err: any) {
    logger.error('❌ Retry webhook delivery error:', { error: err });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /v1/webhooks/health
 * Get per-endpoint webhook delivery health stats for the org.
 */
router.get('/health', requirePermission('messages:read'), async (req: any, res) => {
  try {
    const orgId = req.apiKey?.orgId || req.orgId;
    if (!orgId) {
      return res.status(400).json({ error: 'Organization context required' });
    }

    const [health, counts] = await Promise.all([
      webhookDeliveryStore.getEndpointHealth(orgId),
      webhookDeliveryStore.getDeliveryCounts(orgId),
    ]);

    return res.json({
      endpoints: health,
      totals: counts,
    });
  } catch (err: any) {
    logger.error('❌ Webhook health error:', { error: err });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /v1/webhooks/test
 * Fire a synthetic message.received event to an inbox's webhook URL.
 * Useful for verifying webhook handler logic without sending a real email.
 *
 * Body: { inbox_id: string, event_type?: 'message.received' }
 */
router.post('/test', requirePermission('messages:write'), async (req: any, res) => {
  try {
    const orgId = req.apiKey?.orgId || req.orgId;
    const { inbox_id, event_type = 'message.received' } = req.body || {};

    if (!inbox_id) {
      return res.status(400).json({ error: 'Missing required field: inbox_id' });
    }

    // Fetch the inbox — look it up across all domains for this org
    const inbox = await domainStore.getInboxById(inbox_id, orgId);
    if (!inbox) {
      return res.status(404).json({ error: 'Inbox not found' });
    }

    // Verify the inbox belongs to this org
    if (inbox.orgId && orgId && inbox.orgId !== orgId) {
      return res.status(404).json({ error: 'Inbox not found' });
    }

    // Check webhook is configured
    if (!inbox.webhook?.endpoint) {
      return res.status(400).json({ error: 'No webhook URL configured for this inbox' });
    }

    const endpoint = inbox.webhook.endpoint;
    const webhookSecret = inbox.webhook.secret;

    if (!isAllowedWebhookUrl(endpoint)) {
      return res.status(400).json({ error: 'Invalid webhook URL. Only HTTPS URLs with public hostnames are allowed.' });
    }

    // Build a realistic synthetic message.received payload matching what
    // inboundWebhook.ts sends at lines 526-565
    const now = new Date().toISOString();
    const testMessageId = `test_msg_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const testThreadId = `test_thread_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const inboxAddress = inbox.address || (inbox.localPart ? `${inbox.localPart}@example.com` : 'test@example.com');

    const syntheticPayload: Record<string, any> = {
      domainId: 'test-domain',
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

    // Build signed headers — same as real delivery
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

    // Fire the request with a 10-second timeout
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
    } catch (err: any) {
      errorMessage = err.name === 'AbortError'
        ? 'Timeout after 10000ms'
        : err.message || 'Connection failed';
    }

    const responseTimeMs = Date.now() - start;

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
  } catch (err: any) {
    logger.error('❌ Webhook test error:', { error: err });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
