import { QdrantClient } from '@qdrant/js-client-rest';
import logger from '../utils/logger';
import { SearchFilter, SearchOptions, SearchResult, VectorData, ConversationMetadata, EmailSearchFilter, SmsSearchFilter } from '../types/search';
import { FilterCondition, FieldCondition } from '../types/qdrant';
import { randomUUID } from 'crypto';

export class QdrantService {
  private client: QdrantClient;
  private static instance: QdrantService;

  private constructor() {
    const url = process.env.QDRANT_URL;
    const apiKey = process.env.QDRANT_API_KEY;

    if (!url || !apiKey) {
      throw new Error('QDRANT_URL and QDRANT_API_KEY must be set in environment');
    }

    this.client = new QdrantClient({ url, apiKey });
  }

  public static getInstance(): QdrantService {
    if (!QdrantService.instance) {
      QdrantService.instance = new QdrantService();
    }
    return QdrantService.instance;
  }

  /**
   * Ensure all payload indexes exist on a collection.
   * Idempotent — Qdrant does not error when re-creating an index with the same schema.
   */
  private async ensureIndexes(collectionName: string): Promise<void> {
    const keywordFields = [
      'organizationId',
      'inboxId',
      'domainId',
      'participants',
      'channel',
      'phoneNumberId',
      'fromNumber',
      'toNumber',
    ];

    for (const field of keywordFields) {
      await this.client.createPayloadIndex(collectionName, {
        field_name: field,
        field_schema: 'keyword',
      }).catch((err) => {
        // Qdrant is idempotent on existing indexes — only warn for unexpected errors
        if (!String(err?.message || '').toLowerCase().includes('already exists')) {
          logger.warn('Failed to ensure Qdrant payload index', { collectionName, field, error: err?.message });
        }
      });
    }

    await this.client.createPayloadIndex(collectionName, {
      field_name: 'timestamp',
      field_schema: 'datetime',
    }).catch((err) => {
      if (!String(err?.message || '').toLowerCase().includes('already exists')) {
        logger.warn('Failed to ensure Qdrant timestamp index', { collectionName, error: err?.message });
      }
    });
  }

  public async initializeCollection(organizationId: string): Promise<void> {
    const collectionName = this.getCollectionName(organizationId);

    try {
      // Check if collection exists
      const collections = await this.client.getCollections();
      const exists = collections.collections.some(c => c.name === collectionName);

      if (exists) {
        // Ensure indexes are up-to-date (idempotent — safe to call on existing collections)
        await this.ensureIndexes(collectionName);
        logger.info(`Collection ${collectionName} already exists — indexes verified`);
        return;
      }

      // Create new collection
      await this.client.createCollection(collectionName, {
        vectors: {
          size: 1536, // embed-v-4-0 dimension
          distance: 'Cosine',
        },
        replication_factor: 2,
        write_consistency_factor: 2,
        on_disk_payload: true,
      });

      await this.ensureIndexes(collectionName);

      logger.info(`Initialized collection for organization: ${organizationId}`);
    } catch (error) {
      logger.error('Error initializing collection:', error);
      throw new Error('Failed to initialize collection');
    }
  }

  public async upsertVectors(organizationId: string, vectors: VectorData[]): Promise<void> {
    try {
      // Ensure collection exists before upserting
      await this.initializeCollection(organizationId);

      const collectionName = this.getCollectionName(organizationId);

      // Convert string IDs to UUIDs for Qdrant compatibility
      const points = vectors.map(v => {
        const id = this.isValidUUID(v.id) ? v.id : this.stringToUUID(v.id);

        return {
          id,
          vector: v.vector,
          payload: {
            ...(v.payload as unknown as Record<string, unknown>),
            // Store original message_id in payload for reference
            messageId: v.id,
            timestamp: v.payload.timestamp.toISOString(),
          },
        };
      });

      await this.client.upsert(collectionName, {
        wait: true,
        points,
      });

      logger.info(`Upserted ${vectors.length} vectors for organization: ${organizationId}`);
    } catch (error) {
      logger.error('Error upserting vectors:', error);
      throw new Error('Failed to upsert vectors');
    }
  }

  public async search(
    organizationId: string,
    queryVector: number[],
    filter: SearchFilter,
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
    try {
      const collectionName = this.getCollectionName(organizationId);
      const { limit = 10, offset = 0, minScore = 0.15 } = options;

      // Strict org isolation — always applied
      const must: Array<{ key: string; match: { value: string } }> = [
        { key: 'organizationId', match: { value: organizationId } },
      ];

      // Channel discriminant — narrows to email or sms payload shape
      const channelFilter = filter as EmailSearchFilter | SmsSearchFilter;
      if (channelFilter.channel) {
        must.push({ key: 'channel', match: { value: channelFilter.channel } });
      }

      // Email-specific filters
      if (channelFilter.channel === 'email') {
        const ef = channelFilter as EmailSearchFilter;
        if (ef.inboxIds?.length) {
          must.push({ key: 'inboxId', match: { value: ef.inboxIds[0] } });
        }
        if (ef.domainId) {
          must.push({ key: 'domainId', match: { value: ef.domainId } });
        }
      }

      // SMS-specific filters
      if (channelFilter.channel === 'sms') {
        const sf = channelFilter as SmsSearchFilter;
        if (sf.phoneNumberId) {
          must.push({ key: 'phoneNumberId', match: { value: sf.phoneNumberId } });
        }
        if (sf.fromNumber) {
          must.push({ key: 'fromNumber', match: { value: sf.fromNumber } });
        }
        if (sf.toNumber) {
          must.push({ key: 'toNumber', match: { value: sf.toNumber } });
        }
      }

      // Participant filter — applies to both channels
      if (filter.participants?.length) {
        must.push({ key: 'participants', match: { value: filter.participants[0] } });
      }

      const response = await this.client.search(collectionName, {
        vector: queryVector,
        limit,
        offset,
        score_threshold: minScore,
        filter: { must },
        with_payload: true,
        with_vector: false, // Don't return vectors for security
      });

      return response.map(hit => {
        const payload = hit.payload || {};
        return {
          id: hit.id as string,
          score: hit.score,
          metadata: {
            ...payload as any,
            timestamp: new Date(payload.timestamp as string || new Date().toISOString()),
          } as ConversationMetadata,
        };
      });
    } catch (error) {
      logger.error('Error searching vectors:', error);
      throw new Error('Failed to search vectors');
    }
  }

  /** Delete specific points by message ID. Used in testing and cleanup. */
  public async deletePoints(organizationId: string, messageIds: string[]): Promise<void> {
    try {
      const collectionName = this.getCollectionName(organizationId);
      const uuids = messageIds.map(id => this.isValidUUID(id) ? id : this.stringToUUID(id));
      await this.client.delete(collectionName, {
        wait: true,
        points: uuids,
      });
      logger.info(`Deleted ${uuids.length} points for organization: ${organizationId}`);
    } catch (error) {
      logger.error('Error deleting points:', error);
      throw new Error('Failed to delete points');
    }
  }

  private getCollectionName(organizationId: string): string {
    return `org_${organizationId}_conversations`;
  }

  private isValidUUID(str: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str);
  }

  private stringToUUID(str: string): string {
    // Create a deterministic UUID from a string using MD5-like approach
    // This ensures the same string always produces the same UUID
    const hash = this.simpleHash(str);

    // Format as UUID v4
    return [
      hash.substring(0, 8),
      hash.substring(8, 12),
      '4' + hash.substring(13, 16),
      '8' + hash.substring(17, 20),
      hash.substring(20, 32),
    ].join('-');
  }

  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    // Create a hex string from the hash and pad it
    const hexHash = Math.abs(hash).toString(16).padStart(32, '0');
    return hexHash + hexHash; // Double it to get 64 chars
  }
}
