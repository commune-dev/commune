import { Router, json } from 'express';
import { requirePermission } from '../../middleware/permissions';
import { requireFeature } from '../../middleware/planGate';
import messageStore from '../../stores/messageStore';
import logger from '../../utils/logger';

const router = Router();

/**
 * Attempt vector search via SearchService (Qdrant + Azure OpenAI embeddings).
 * Returns null if the vector stack is not configured or fails, so we can fall back to regex.
 *
 * Supports both email (inbox_id / domain_id) and SMS (phone_number_id / from_number / to_number) filters.
 * When SMS params are present the search filter is set to channel:'sms'; email params use channel:'email'.
 * No channel params = cross-channel search across all indexed content.
 */
const tryVectorSearch = async (
  orgId: string,
  query: string,
  options: {
    inboxId?: string;
    domainId?: string;
    phoneNumberId?: string;
    fromNumber?: string;
    toNumber?: string;
    limit?: number;
  }
): Promise<any[] | null> => {
  const { inboxId, domainId, phoneNumberId, fromNumber, toNumber, limit = 20 } = options;
  try {
    if (!process.env.QDRANT_URL || !process.env.AZURE_OPENAI_EMBEDDING_API_KEY) {
      return null;
    }

    const { SearchService } = await import('../../services/searchService');
    const searchService = SearchService.getInstance();

    // Build channel-specific filter
    const filter = (() => {
      if (phoneNumberId || fromNumber || toNumber) {
        return {
          organizationId: orgId,
          channel: 'sms' as const,
          phoneNumberId,
          fromNumber,
          toNumber,
        };
      }
      if (inboxId || domainId) {
        return {
          organizationId: orgId,
          channel: 'email' as const,
          inboxIds: inboxId ? [inboxId] : undefined,
          domainId,
        };
      }
      // No channel filter — search across both email and SMS
      return { organizationId: orgId };
    })();

    const results = await searchService.search(orgId, query, filter, { limit, minScore: 0.15 });

    if (!results || results.length === 0) return null;

    return results.map((r) => ({
      thread_id: r.metadata.threadId,
      subject: r.metadata.channel === 'email' ? r.metadata.subject : null,
      score: r.score,
      inbox_id: r.metadata.inboxId,
      domain_id: r.metadata.channel === 'email' ? r.metadata.domainId : null,
      phone_number_id: r.metadata.channel === 'sms' ? r.metadata.phoneNumberId : null,
      from_number: r.metadata.channel === 'sms' ? r.metadata.fromNumber : null,
      to_number: r.metadata.channel === 'sms' ? r.metadata.toNumber : null,
      participants: r.metadata.participants,
      direction: r.metadata.direction,
      channel: r.metadata.channel,
    }));
  } catch (err) {
    logger.warn('Vector search unavailable, falling back to regex', { error: (err as Error).message });
    return null;
  }
};

/**
 * GET /v1/search/threads
 * Search threads by natural language query.
 *
 * Uses vector search (Qdrant + embeddings) when available,
 * falls back to regex-based subject/content search.
 *
 * Query params:
 *   q                - Search query (required)
 *   inbox_id         - Filter to email inbox
 *   domain_id        - Filter to email domain
 *   phone_number_id  - Filter to SMS phone number (org's number)
 *   from_number      - Filter to SMS from a specific E.164 number
 *   to_number        - Filter to SMS sent to a specific E.164 number
 *   limit            - Max results (1-100, default 20)
 *
 * At least one of: inbox_id, domain_id, phone_number_id, from_number, to_number is required.
 */
router.get('/threads', requireFeature('semanticSearch'), requirePermission('threads:read'), async (req: any, res) => {
  const orgId = req.orgId;
  const query = (req.query.q as string || '').trim();
  const inboxId = req.query.inbox_id as string | undefined;
  const domainId = req.query.domain_id as string | undefined;
  const phoneNumberId = req.query.phone_number_id as string | undefined;
  const fromNumber = req.query.from_number as string | undefined;
  const toNumber = req.query.to_number as string | undefined;
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

  if (!query) {
    return res.status(400).json({ error: 'Missing required query parameter: q' });
  }

  if (!inboxId && !domainId && !phoneNumberId && !fromNumber && !toNumber) {
    return res.status(400).json({
      error: 'At least one filter is required: inbox_id, domain_id, phone_number_id, from_number, or to_number',
    });
  }

  try {
    // Try vector search first (semantic, better quality)
    const vectorResults = await tryVectorSearch(orgId, query, {
      inboxId, domainId, phoneNumberId, fromNumber, toNumber, limit,
    });
    if (vectorResults) {
      return res.json({ data: vectorResults, search_type: 'vector' });
    }

    // Fallback: regex-based text search (email only for now)
    const results = await messageStore.searchThreads({
      query,
      inboxId,
      domainId,
      orgId,
      limit,
    });

    return res.json({ data: results, search_type: 'regex' });
  } catch (err) {
    logger.error('v1: Thread search failed', { orgId, query, error: err });
    return res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * POST /v1/search
 * Deprecated compatibility route for old SDK clients.
 * Canonical route is GET /v1/search/threads.
 */
router.post('/', json(), requireFeature('semanticSearch'), requirePermission('threads:read'), async (req: any, res) => {
  const query = (req.body?.query as string || '').trim();
  const filter = req.body?.filter || {};
  const options = req.body?.options || {};
  const inboxId = Array.isArray(filter.inboxIds) && filter.inboxIds.length > 0 ? filter.inboxIds[0] : undefined;
  const domainId = filter.domainId as string | undefined;
  const phoneNumberId = filter.phoneNumberId as string | undefined;
  const fromNumber = filter.fromNumber as string | undefined;
  const toNumber = filter.toNumber as string | undefined;
  const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 100);

  if (!query) {
    return res.status(400).json({ error: 'Missing required field: query' });
  }
  if (!inboxId && !domainId && !phoneNumberId && !fromNumber && !toNumber) {
    return res.status(400).json({
      error: 'At least one filter is required: inboxIds, domainId, phoneNumberId, fromNumber, or toNumber',
    });
  }

  try {
    const orgId = req.orgId;
    const vectorResults = await tryVectorSearch(orgId, query, {
      inboxId, domainId, phoneNumberId, fromNumber, toNumber, limit,
    });
    if (vectorResults) {
      return res.json({ data: vectorResults });
    }

    const results = await messageStore.searchThreads({
      query,
      inboxId,
      domainId,
      orgId,
      limit,
    });
    return res.json({ data: results });
  } catch (err) {
    logger.error('v1: Legacy search endpoint failed', { error: err });
    return res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * POST /v1/search/index
 * Deprecated compatibility route. Indexing is automatic.
 */
router.post('/index', json(), requireFeature('semanticSearch'), async (_req: any, res) => {
  return res.json({ data: { success: true } });
});

/**
 * POST /v1/search/index/batch
 * Deprecated compatibility route. Indexing is automatic.
 */
router.post('/index/batch', json(), requireFeature('semanticSearch'), async (_req: any, res) => {
  return res.json({ data: { success: true } });
});

export default router;
