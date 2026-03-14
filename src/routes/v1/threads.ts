import { Router, json } from 'express';
import messageStore from '../../stores/messageStore';
import threadMetadataStore from '../../stores/threadMetadataStore';
import { requirePermission } from '../../middleware/permissions';
import logger from '../../utils/logger';

const router = Router();

/**
 * GET /v1/threads
 * List email threads with cursor-based pagination.
 *
 * Query params:
 *   inbox_id  - Filter by inbox (recommended)
 *   domain_id - Filter by domain
 *   limit     - Max results per page (1-100, default 20)
 *   cursor    - Pagination cursor from previous response
 *   order     - Sort order: 'desc' (newest first, default) or 'asc'
 */
router.get('/', requirePermission('threads:read'), async (req: any, res) => {
  const orgId = req.orgId;
  const {
    inbox_id,
    domain_id,
    limit: rawLimit,
    cursor,
    order,
  } = req.query;

  if (!inbox_id && !domain_id) {
    return res.status(400).json({
      error: 'Missing required query parameter: inbox_id or domain_id',
    });
  }

  const limit = Math.min(Math.max(Number(rawLimit) || 20, 1), 100);

  try {
    const result = await messageStore.listThreads({
      inboxId: inbox_id as string | undefined,
      domainId: domain_id as string | undefined,
      limit,
      cursor: cursor as string | undefined,
      order: (order as 'asc' | 'desc') || 'desc',
      orgId,
    });

    res.set('Cache-Control', 'private, max-age=5, stale-while-revalidate=15');
    return res.json({
      data: result.threads,
      next_cursor: result.next_cursor,
      has_more: result.next_cursor !== null,
    });
  } catch (err) {
    logger.error('v1: Failed to list threads', { orgId, error: err });
    return res.status(500).json({ error: 'Failed to list threads' });
  }
});

/**
 * GET /v1/threads/:threadId/messages
 * Get all messages in a thread, ordered chronologically.
 *
 * Query params:
 *   limit - Max messages to return (1-1000, default 50)
 *   order - 'asc' (default, oldest first) or 'desc'
 */
router.get('/:threadId/messages', requirePermission('threads:read'), async (req: any, res) => {
  const { threadId } = req.params;
  const orgId = req.orgId;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 1000);
  const order = (req.query.order as 'asc' | 'desc') || 'asc';

  try {
    const messages = await messageStore.getMessagesByThread(
      threadId,
      limit,
      order,
      orgId
    );

    return res.json({ data: messages });
  } catch (err) {
    logger.error('v1: Failed to get thread messages', { orgId, threadId, error: err });
    return res.status(500).json({ error: 'Failed to get thread messages' });
  }
});

// ─── Thread Triage Endpoints ─────────────────────────────────────────────────

/**
 * GET /v1/threads/:threadId/metadata
 * Get triage metadata (tags, status, assignment) for a thread.
 */
router.get('/:threadId/metadata', requirePermission('threads:read'), async (req: any, res) => {
  const { threadId } = req.params;
  const orgId = req.orgId;

  try {
    const meta = await threadMetadataStore.get(threadId, orgId);
    return res.json({
      data: meta || { thread_id: threadId, tags: [], status: 'open', assigned_to: null },
    });
  } catch (err) {
    logger.error('v1: Failed to get thread metadata', { orgId, threadId, error: err });
    return res.status(500).json({ error: 'Failed to get thread metadata' });
  }
});

/**
 * PUT /v1/threads/:threadId/status
 * Set thread status: "open", "needs_reply", "waiting", "closed"
 * Body: { status: string }
 */
router.put('/:threadId/status', json(), requirePermission('threads:write'), async (req: any, res) => {
  const { threadId } = req.params;
  const orgId = req.orgId;
  const { status } = req.body || {};

  const validStatuses = ['open', 'needs_reply', 'waiting', 'closed'];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }

  try {
    const meta = await threadMetadataStore.upsert(threadId, orgId, { status });
    return res.json({ data: meta });
  } catch (err) {
    logger.error('v1: Failed to set thread status', { orgId, threadId, error: err });
    return res.status(500).json({ error: 'Failed to set thread status' });
  }
});

/**
 * POST /v1/threads/:threadId/tags
 * Add tags to a thread.
 * Body: { tags: string[] }
 */
router.post('/:threadId/tags', json(), requirePermission('threads:write'), async (req: any, res) => {
  const { threadId } = req.params;
  const orgId = req.orgId;
  const { tags } = req.body || {};

  if (!Array.isArray(tags) || tags.length === 0) {
    return res.status(400).json({ error: 'tags must be a non-empty array of strings' });
  }

  try {
    const meta = await threadMetadataStore.addTags(threadId, orgId, tags);
    return res.json({ data: meta });
  } catch (err) {
    logger.error('v1: Failed to add thread tags', { orgId, threadId, error: err });
    return res.status(500).json({ error: 'Failed to add thread tags' });
  }
});

/**
 * DELETE /v1/threads/:threadId/tags
 * Remove tags from a thread.
 * Body: { tags: string[] }
 */
router.delete('/:threadId/tags', json(), requirePermission('threads:write'), async (req: any, res) => {
  const { threadId } = req.params;
  const orgId = req.orgId;
  const { tags } = req.body || {};

  if (!Array.isArray(tags) || tags.length === 0) {
    return res.status(400).json({ error: 'tags must be a non-empty array of strings' });
  }

  try {
    const meta = await threadMetadataStore.removeTags(threadId, orgId, tags);
    return res.json({ data: meta || { thread_id: threadId, tags: [], status: 'open' } });
  } catch (err) {
    logger.error('v1: Failed to remove thread tags', { orgId, threadId, error: err });
    return res.status(500).json({ error: 'Failed to remove thread tags' });
  }
});

/**
 * PUT /v1/threads/:threadId/assign
 * Assign a thread to an agent/user.
 * Body: { assigned_to: string | null }
 */
router.put('/:threadId/assign', json(), requirePermission('threads:write'), async (req: any, res) => {
  const { threadId } = req.params;
  const orgId = req.orgId;
  const { assigned_to } = req.body || {};

  if (assigned_to !== null && typeof assigned_to !== 'string') {
    return res.status(400).json({ error: 'assigned_to must be a string or null' });
  }

  try {
    const meta = await threadMetadataStore.upsert(threadId, orgId, { assigned_to: assigned_to ?? null });
    return res.json({ data: meta });
  } catch (err) {
    logger.error('v1: Failed to assign thread', { orgId, threadId, error: err });
    return res.status(500).json({ error: 'Failed to assign thread' });
  }
});

export default router;
