import { VectorService } from './vectorService';
import { QdrantService } from './qdrantService';
import { SearchFilter, SearchOptions, SearchResult, ConversationMetadata } from '../types/search';
import logger from '../utils/logger';

export class SearchService {
  private vectorService: VectorService;
  private qdrantService: QdrantService;
  private static instance: SearchService;

  private constructor() {
    this.vectorService = VectorService.getInstance();
    this.qdrantService = QdrantService.getInstance();
  }

  public static getInstance(): SearchService {
    if (!SearchService.instance) {
      SearchService.instance = new SearchService();
    }
    return SearchService.instance;
  }

  public async search(
    organizationId: string,
    query: string,
    filter: SearchFilter,
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    try {
      // Generate embedding for search query
      const queryVector = await this.vectorService.generateEmbedding(query);

      // Search vectors with filters
      const results = await this.qdrantService.search(
        organizationId,
        queryVector,
        filter,
        options
      );

      return results;
    } catch (error) {
      logger.error('Error performing search:', error);
      throw new Error('Failed to perform search');
    }
  }

  public async indexConversation(
    organizationId: string,
    conversation: {
      id: string;
      subject: string;
      content: string;
      metadata: ConversationMetadata;
    }
  ): Promise<void> {
    try {
      // Prepare text for embedding
      const text = await this.vectorService.prepareConversationText({
        subject: conversation.subject,
        content: conversation.content,
        metadata: conversation.metadata as unknown as Record<string, unknown>,
      });

      // Generate embedding
      const vector = await this.vectorService.generateEmbedding(text);

      // Index in Qdrant
      await this.qdrantService.upsertVectors(organizationId, [{
        id: conversation.id,
        vector,
        payload: conversation.metadata,
      }]);

      logger.info(`Indexed conversation: ${conversation.id}`);
    } catch (error) {
      logger.error('Error indexing conversation:', error);
      throw new Error('Failed to index conversation');
    }
  }

  public async indexConversationsBatch(
    organizationId: string,
    conversations: Array<{
      id: string;
      subject: string;
      content: string;
      metadata: ConversationMetadata;
    }>
  ): Promise<void> {
    try {
      // Prepare texts for embedding
      const texts = await Promise.all(
        conversations.map(conv =>
          this.vectorService.prepareConversationText({
            subject: conv.subject,
            content: conv.content,
            metadata: conv.metadata as unknown as Record<string, unknown>,
          })
        )
      );

      // Generate embeddings in batch
      const vectors = await this.vectorService.generateEmbeddingsBatch(texts);

      // Index in Qdrant
      await this.qdrantService.upsertVectors(
        organizationId,
        conversations.map((conv, i) => ({
          id: conv.id,
          vector: vectors[i],
          payload: conv.metadata,
        }))
      );

      logger.info(`Indexed ${conversations.length} conversations in batch`);
    } catch (error) {
      logger.error('Error indexing conversations batch:', error);
      throw new Error('Failed to index conversations batch');
    }
  }
}
