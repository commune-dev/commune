import { SearchService } from '../searchService';
import type { SmsMessageMetadata } from '../../types/search';
import type { UnifiedMessage } from '../../types';
import logger from '../../utils/logger';

/**
 * SmsProcessor — indexes SMS messages into Qdrant for vector search.
 * Mirrors EmailProcessor but sets channel:'sms' in the payload and uses
 * the message body (not email subject) as the indexing anchor.
 */
export class SmsProcessor {
  private searchService: SearchService;
  private static instance: SmsProcessor;

  private constructor() {
    this.searchService = SearchService.getInstance();
  }

  public static getInstance(): SmsProcessor {
    if (!SmsProcessor.instance) {
      SmsProcessor.instance = new SmsProcessor();
    }
    return SmsProcessor.instance;
  }

  public async processMessage(message: UnifiedMessage): Promise<void> {
    try {
      const fromNumber = message.metadata.from_number ?? '';
      const toNumber = message.metadata.to_number ?? '';
      const phoneNumberId = message.metadata.phone_number_id ?? message.metadata.inbox_id ?? '';

      // Always include phone context as a prefix so that phone numbers are
      // semantically searchable (e.g. "messages from +15551234567") and short
      // bodies produce useful embeddings.
      const content = `SMS from ${fromNumber} to ${toNumber}: ${message.content || ''}`;

      const metadata: SmsMessageMetadata = {
        channel: 'sms',
        organizationId: message.orgId || '',
        inboxId: phoneNumberId,
        participants: message.participants.map(p => p.identity),
        threadId: message.thread_id || message.message_id,
        timestamp: new Date(message.created_at),
        direction: (message.direction as 'inbound' | 'outbound') || 'inbound',
        phoneNumberId,
        fromNumber,
        toNumber,
      };

      await this.searchService.indexConversation(metadata.organizationId, {
        id: message.message_id,
        subject: '',
        content,
        metadata,
      });

      logger.info('SMS indexed for vector search', {
        messageId: message.message_id,
        organizationId: metadata.organizationId,
        direction: metadata.direction,
      });
    } catch (error) {
      logger.error('Failed to index SMS for vector search', {
        error,
        messageId: message.message_id,
      });
      // Never throw — don't disrupt message flow
    }
  }
}
