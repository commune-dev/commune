import { randomUUID } from 'crypto';
import { getCollection } from '../db';
import logger from '../utils/logger';

export interface BlockedSpamEmail {
  _id: string;
  org_id: string;
  inbox_id?: string;
  sender_email: string;
  sender_domain: string;
  subject: string;
  blocked_at: Date;
  spam_score: number;
  reasons: string[];
  classification: 'spam' | 'phishing' | 'malware' | 'mass_attack' | 'other';
  metadata: {
    to: string[];
    content_preview: string; // First 200 chars
    url_count: number;
    has_attachments: boolean;
    sender_reputation: number;
    domain_reputation: number;
  };
}

const ensureIndexes = async () => {
  try {
    const collection = await getCollection<BlockedSpamEmail>('blocked_spam_emails');
    if (collection) {
      await collection.createIndex({ org_id: 1, blocked_at: -1 });
      await collection.createIndex({ sender_email: 1 });
      await collection.createIndex({ sender_domain: 1 });
      await collection.createIndex({ blocked_at: -1 });
      await collection.createIndex({ classification: 1 });
      // TTL index - auto-delete after 90 days
      await collection.createIndex({ blocked_at: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
      // Sender domain lookup scoped to org (e.g. "how many blocked from this domain?")
      await collection.createIndex(
        { org_id: 1, sender_domain: 1 },
        { background: true, name: 'spam_by_sender_domain' }
      );
    }
  } catch (error) {
    logger.error('Failed to ensure blocked spam indexes:', error);
  }
};

const storeBlockedEmail = async (email: Omit<BlockedSpamEmail, '_id'>): Promise<void> => {
  try {
    const collection = await getCollection<BlockedSpamEmail>('blocked_spam_emails');
    if (!collection) return;

    const doc: BlockedSpamEmail = {
      _id: randomUUID(),
      ...email,
    };

    await collection.insertOne(doc as any);
    
    logger.info('Blocked spam email stored', {
      sender: email.sender_email,
      org_id: email.org_id,
      classification: email.classification,
    });
  } catch (error) {
    logger.error('Failed to store blocked spam email:', error);
  }
};

const getBlockedEmails = async (
  orgId: string,
  options: {
    limit?: number;
    offset?: number;
    startDate?: Date;
    endDate?: Date;
    classification?: string;
  } = {}
): Promise<BlockedSpamEmail[]> => {
  try {
    const collection = await getCollection<BlockedSpamEmail>('blocked_spam_emails');
    if (!collection) return [];

    const { limit = 50, offset = 0, startDate, endDate, classification } = options;

    const query: any = { org_id: orgId };

    if (startDate || endDate) {
      query.blocked_at = {};
      if (startDate) query.blocked_at.$gte = startDate;
      if (endDate) query.blocked_at.$lte = endDate;
    }

    if (classification) {
      query.classification = classification;
    }

    return collection
      .find(query)
      .sort({ blocked_at: -1 })
      .skip(offset)
      .limit(limit)
      .toArray();
  } catch (error) {
    logger.error('Failed to get blocked emails:', error);
    return [];
  }
};

const getBlockedEmailStats = async (
  orgId: string,
  days: number = 7
): Promise<{
  total_blocked: number;
  by_classification: Record<string, number>;
  top_blocked_senders: Array<{ email: string; count: number }>;
  blocked_by_day: Array<{ date: string; count: number }>;
}> => {
  try {
    const collection = await getCollection<BlockedSpamEmail>('blocked_spam_emails');
    if (!collection) {
      return {
        total_blocked: 0,
        by_classification: {},
        top_blocked_senders: [],
        blocked_by_day: [],
      };
    }

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const emails = await collection
      .find({
        org_id: orgId,
        blocked_at: { $gte: startDate },
      })
      .toArray();

    // Count by classification
    const byClassification: Record<string, number> = {};
    emails.forEach(email => {
      byClassification[email.classification] = (byClassification[email.classification] || 0) + 1;
    });

    // Top blocked senders
    const senderCounts = new Map<string, number>();
    emails.forEach(email => {
      senderCounts.set(email.sender_email, (senderCounts.get(email.sender_email) || 0) + 1);
    });

    const topBlockedSenders = Array.from(senderCounts.entries())
      .map(([email, count]) => ({ email, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Blocked by day
    const dayMap = new Map<string, number>();
    emails.forEach(email => {
      const date = email.blocked_at.toISOString().split('T')[0];
      dayMap.set(date, (dayMap.get(date) || 0) + 1);
    });

    const blockedByDay = Array.from(dayMap.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return {
      total_blocked: emails.length,
      by_classification: byClassification,
      top_blocked_senders: topBlockedSenders,
      blocked_by_day: blockedByDay,
    };
  } catch (error) {
    logger.error('Failed to get blocked email stats:', error);
    return {
      total_blocked: 0,
      by_classification: {},
      top_blocked_senders: [],
      blocked_by_day: [],
    };
  }
};

export default {
  ensureIndexes,
  storeBlockedEmail,
  getBlockedEmails,
  getBlockedEmailStats,
};
