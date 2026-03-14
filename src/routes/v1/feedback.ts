import { Router } from 'express';
import { z } from 'zod';
import { getCollection } from '../../db';
import { feedbackLimiter } from '../../middleware/rateLimiter';
import logger from '../../utils/logger';

const router = Router();

const FeedbackSchema = z.object({
  type: z.enum(['error', 'feature', 'signal']),
  message: z.string().min(1).max(4000),
  context: z.record(z.unknown()).optional(),
});

// ─── POST /v1/feedback ────────────────────────────────────────────

router.post('/', feedbackLimiter, async (req: any, res) => {
  const parsed = FeedbackSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  const { type, message, context } = parsed.data;
  const orgId: string | undefined = req.orgId;
  const agentId: string | undefined = req.agentId;

  const doc = {
    orgId: orgId ?? null,
    agentId: agentId ?? null,
    type,
    message,
    context: context ?? null,
    status: 'received',
    created_at: new Date(),
  };

  try {
    const collection = await getCollection('feedback');
    if (!collection) {
      logger.error('feedback.submit_failed: collection unavailable', { orgId });
      return res.status(503).json({ error: 'Service temporarily unavailable' });
    }

    const result = await collection.insertOne(doc);

    logger.info('feedback.submitted', { orgId, agentId, type, id: result.insertedId });

    return res.status(201).json({
      data: {
        id: result.insertedId.toString(),
        type,
        status: 'received',
        created_at: doc.created_at.toISOString(),
      },
    });
  } catch (err: any) {
    logger.error('feedback.submit_failed', { orgId, error: err.message });
    return res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

export default router;
