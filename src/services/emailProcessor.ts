import { SearchService } from './searchService';
import type { EmailMessageMetadata } from '../types/search';
import type { UnifiedMessage, Participant } from '../types';
import logger from '../utils/logger';

export class EmailProcessor {
  private searchService: SearchService;
  private static instance: EmailProcessor;

  private constructor() {
    this.searchService = SearchService.getInstance();
  }

  public static getInstance(): EmailProcessor {
    if (!EmailProcessor.instance) {
      EmailProcessor.instance = new EmailProcessor();
    }
    return EmailProcessor.instance;
  }

  public async processMessage(message: UnifiedMessage): Promise<void> {
    try {
      // Extract metadata for vector indexing
      const metadata: EmailMessageMetadata = {
        channel: 'email',
        organizationId: message.orgId || '',
        inboxId: message.metadata.inbox_id || '',
        domainId: message.metadata.domain_id || '',
        participants: message.participants.map((p: Participant) => p.identity),
        threadId: message.thread_id || message.message_id,
        timestamp: new Date(message.created_at),
        direction: (message.direction as 'inbound' | 'outbound') || 'inbound',
        subject: message.metadata.subject || '',
        attachmentIds: message.attachments || [],
        hasAttachments: (message.attachments || []).length > 0,
        attachmentCount: (message.attachments || []).length,
      };

      // Index the message content
      await this.searchService.indexConversation(metadata.organizationId, {
        id: message.message_id,
        subject: message.metadata.subject || '',
        content: message.content,
        metadata,
      });

      logger.info('Message indexed for vector search', {
        messageId: message.message_id,
        organizationId: metadata.organizationId,
        attachmentCount: metadata.attachmentCount,
      });
    } catch (error) {
      logger.error('Failed to index message for vector search', {
        error,
        messageId: message.message_id,
      });
      // Don't throw error to avoid disrupting message flow
    }
  }

  public async processMessageBatch(messages: UnifiedMessage[]): Promise<void> {
    try {
      const conversationsToIndex = messages.map(message => {
        const meta: EmailMessageMetadata = {
          channel: 'email',
          organizationId: message.orgId || '',
          inboxId: message.metadata.inbox_id || '',
          domainId: message.metadata.domain_id || '',
          participants: message.participants.map((p: Participant) => p.identity),
          threadId: message.thread_id || message.message_id,
          timestamp: new Date(message.created_at),
          direction: (message.direction as 'inbound' | 'outbound') || 'inbound',
          subject: message.metadata.subject || '',
          attachmentIds: message.attachments || [],
          hasAttachments: (message.attachments || []).length > 0,
          attachmentCount: (message.attachments || []).length,
        };
        return { id: message.message_id, subject: meta.subject, content: message.content, metadata: meta };
      });

      if (conversationsToIndex.length > 0) {
        const organizationId = conversationsToIndex[0].metadata.organizationId;
        await this.searchService.indexConversationsBatch(organizationId, conversationsToIndex);

        logger.info('Batch messages indexed for vector search', {
          count: messages.length,
          organizationId,
        });
      }
    } catch (error) {
      logger.error('Failed to index message batch for vector search', {
        error,
        count: messages.length,
      });
      // Don't throw error to avoid disrupting message flow
    }
  }
}
