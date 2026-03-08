import resend from './resendClient';
import logger from '../utils/logger';
import resendHttp, { type WebhookPayload } from './resendHttp';
import domainStore from '../stores/domainStore';
import { getRedisClient } from '../lib/redis';
import type { CreateDomainOptions } from 'resend';

const DEFAULT_REGION = process.env.RESEND_REGION || 'us-east-1';
const WEBHOOK_BASE_URL = process.env.PUBLIC_WEBHOOK_BASE_URL;
const COMPREHENSIVE_WEBHOOK_EVENTS = [
  'email.sent',
  'email.delivered',
  'email.bounced',
  'email.complained',
  'email.failed',
  'email.delivery_delayed',
  'email.received',
];

const buildWebhookEndpoint = (domainId: string) => {
  if (!WEBHOOK_BASE_URL) {
    return null;
  }

  return `${WEBHOOK_BASE_URL.replace(/\/$/, '')}/api/webhooks/resend`;
};

const normalizeWebhookPayload = (payload: unknown): WebhookPayload | null => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if ('data' in (payload as Record<string, unknown>) && (payload as any).data) {
    return (payload as any).data as WebhookPayload;
  }

  return payload as WebhookPayload;
};

const extractWebhookSecret = (payload: WebhookPayload | null) =>
  payload?.secret || payload?.signing_secret || payload?.webhook_secret || null;

type DomainRegion = NonNullable<CreateDomainOptions['region']>;

const resolveRegion = (region?: string): DomainRegion => {
  const allowed: DomainRegion[] = ['us-east-1', 'eu-west-1', 'sa-east-1', 'ap-northeast-1'];
  if (region && allowed.includes(region as DomainRegion)) {
    return region as DomainRegion;
  }

  return 'us-east-1';
};

const createDomain = async ({
  name,
  region,
  capabilities,
  orgId,
}: {
  name: string;
  region?: string;
  capabilities?: { sending?: string; receiving?: string };
  orgId?: string | null;
}) => {
  const params: CreateDomainOptions & {
    capabilities?: { sending?: string; receiving?: string };
  } = {
    name,
    region: resolveRegion(region || DEFAULT_REGION),
    capabilities: capabilities || {
      sending: 'enabled',
      receiving: 'enabled',
    },
  };

  const { data, error } = await resend.domains.create(params as CreateDomainOptions);

  if (error) {
    return { error };
  }

  if (!data) {
    return { error: { message: 'Resend did not return domain data' } };
  }

  const entry = {
    id: data.id,
    name: data.name,
    status: data.status,
    region: data.region,
    records: data.records || [],
    createdAt: data.created_at,
    orgId: orgId || undefined,
  };
  await domainStore.upsertDomain(entry);

  // Register domain in the spam filter's verified-sender allowlist.
  // Domains created through Commune's management have customer-configured DKIM/SPF
  // and should bypass content-based spam scoring for inbound email.
  const redis = getRedisClient();
  if (redis && data.name) {
    redis.sadd('commune:verified:domains', data.name).catch((err) => {
      logger.warn('Failed to add domain to verified allowlist in Redis:', { error: err });
    });
  }

  // Register comprehensive webhook for ALL events
  const webhookEndpoint = buildWebhookEndpoint(data.id);
  let webhookData = null;
  if (webhookEndpoint) {
    const { data: webhookResponse, error: webhookError } = await resendHttp.createWebhook({
      endpoint: webhookEndpoint,
      events: COMPREHENSIVE_WEBHOOK_EVENTS,
    });
    
    if (webhookError) {
      logger.warn('⚠️ Failed to create comprehensive webhook:', { error: webhookError });
    } else {
      logger.info('🪝 Registered comprehensive webhook:', { webhookResponse });
      webhookData = webhookResponse;
      
      const webhookPayload = normalizeWebhookPayload(webhookResponse);
      const webhookSecret = extractWebhookSecret(webhookPayload);

      await domainStore.upsertDomain({
        id: data.id,
        webhook: {
          id: webhookPayload?.id,
          endpoint: webhookPayload?.endpoint || webhookEndpoint,
          events: webhookPayload?.events || COMPREHENSIVE_WEBHOOK_EVENTS,
          secret: webhookSecret || undefined,
        },
      });
    }
  }

  return { data, entry, webhook: webhookData };
};

const listDomains = async () => resend.domains.list();

const getDomain = async (domainId: string) => resend.domains.get(domainId);

const verifyDomain = async (domainId: string) => resend.domains.verify(domainId);

const createInboundWebhook = async (domainId: string, endpoint?: string, events?: string[]) => {
  const webhookEndpoint = endpoint || buildWebhookEndpoint(domainId);
  if (!webhookEndpoint) {
    return { error: { message: 'PUBLIC_WEBHOOK_BASE_URL is not set' } };
  }

  const existing = await domainStore.getDomain(domainId);
  if (existing?.webhook?.id) {
    return { data: existing.webhook, entry: existing };
  }
  if (!existing) {
    const { data: domainData, error: domainError } = await resend.domains.get(domainId);
    if (domainError) {
      return { error: domainError };
    }

    if (!domainData) {
      return { error: { message: 'Resend did not return domain data' } };
    }

    await domainStore.upsertDomain({
      id: domainData.id,
      name: domainData.name,
      status: domainData.status,
      region: domainData.region,
      records: domainData.records || [],
      createdAt: domainData.created_at,
    });
  }

  const { data, error } = await resendHttp.createWebhook({
    endpoint: webhookEndpoint,
    events: events && events.length ? events : COMPREHENSIVE_WEBHOOK_EVENTS,
  });

  if (error) {
    return { error };
  }

  if (!data) {
    return { error: { message: 'Resend did not return webhook data' } };
  }

  const webhookPayload = normalizeWebhookPayload(data);
  const webhookSecret = extractWebhookSecret(webhookPayload);

  await domainStore.upsertDomain({
    id: domainId,
    webhook: {
      id: webhookPayload?.id,
      endpoint: webhookPayload?.endpoint || webhookEndpoint,
      events:
        webhookPayload?.events || (events && events.length ? events : COMPREHENSIVE_WEBHOOK_EVENTS),
      secret: webhookSecret || undefined,
    },
  });

  return { data, entry: null };
};

const refreshDomainRecords = async (domainId: string) => {
  const { data, error } = await resend.domains.get(domainId);
  if (error) {
    return { error };
  }

  if (!data) {
    return { error: { message: 'Resend did not return domain data' } };
  }

  await domainStore.upsertDomain({
    id: domainId,
    records: data.records || [],
  });
  return { data, entry: null };
};

const storeWebhookSecret = async (domainId: string, secret: string) => {
  const entry = {
    id: domainId,
    webhook: { secret },
  };

  await domainStore.upsertDomain(entry);
  return entry;
};

export default {
  createDomain,
  listDomains,
  getDomain,
  verifyDomain,
  createInboundWebhook,
  refreshDomainRecords,
  buildWebhookEndpoint,
  storeWebhookSecret,
};
