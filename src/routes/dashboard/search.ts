import express from 'express';
import { z } from 'zod';
import { SearchService } from '../../services/searchService';
import { SearchFilterSchema, ConversationMetadata } from '../../types/search';
import { requireFeature } from '../../middleware/planGate';
import logger from '../../utils/logger';

const router = express.Router();
const searchService = SearchService.getInstance();

const SearchRequestSchema = z.object({
  query: z.string(),
  filter: SearchFilterSchema,
  options: z.object({
    limit: z.number().optional(),
    offset: z.number().optional(),
    minScore: z.number().optional(),
  }).optional(),
});

// POST /api/search — requires semanticSearch feature
router.post('/', requireFeature('semanticSearch'), async (req, res) => {
  try {
    const { query, filter, options } = SearchRequestSchema.parse(req.body);
    const results = await searchService.search(
      filter.organizationId,
      query,
      filter,
      options
    );

    res.json({ data: results });
  } catch (error) {
    logger.error('Search error:', error);
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request data', details: error.errors });
    } else {
      res.status(500).json({ error: 'Failed to perform search' });
    }
  }
});

// POST /api/search/index
router.post('/index', async (req, res) => {
  try {
    const { organizationId, conversation } = z.object({
      organizationId: z.string(),
      conversation: z.object({
        id: z.string(),
        subject: z.string(),
        content: z.string(),
        metadata: z.object({
          subject: z.string(),
          organizationId: z.string(),
          inboxId: z.string(),
          domainId: z.string(),
          participants: z.array(z.string()),
          threadId: z.string(),
          timestamp: z.coerce.date(),
        }),
      }),
    }).parse(req.body);

    await searchService.indexConversation(organizationId, {
      ...conversation,
      metadata: conversation.metadata as unknown as ConversationMetadata,
    });
    res.json({ data: { success: true } });
  } catch (error) {
    logger.error('Index error:', error);
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request data', details: error.errors });
    } else {
      res.status(500).json({ error: 'Failed to index conversation' });
    }
  }
});

// POST /api/search/index/batch
router.post('/index/batch', async (req, res) => {
  try {
    const { organizationId, conversations } = z.object({
      organizationId: z.string(),
      conversations: z.array(z.object({
        id: z.string(),
        subject: z.string(),
        content: z.string(),
        metadata: z.object({
          subject: z.string(),
          organizationId: z.string(),
          inboxId: z.string(),
          domainId: z.string(),
          participants: z.array(z.string()),
          threadId: z.string(),
          timestamp: z.coerce.date(),
        }),
      })),
    }).parse(req.body);

    await searchService.indexConversationsBatch(organizationId, conversations.map(c => ({
      ...c,
      metadata: c.metadata as unknown as ConversationMetadata,
    })));
    res.json({ data: { success: true } });
  } catch (error) {
    logger.error('Batch index error:', error);
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request data', details: error.errors });
    } else {
      res.status(500).json({ error: 'Failed to index conversations batch' });
    }
  }
});

export default router;
