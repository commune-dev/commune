import { getCollection } from '../db';
import logger from '../utils/logger';

interface MetricsData {
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  failed: number;
  suppressed: number;
  orphan_events: number;
  delivery_rate: number;
  bounce_rate: number;
  complaint_rate: number;
  failure_rate: number;
  suppression_rate: number;
  orphan_event_rate: number;
}

interface TimeWindowMetrics extends MetricsData {
  time_window: string;
  calculated_at: string;
}

interface MessageOutcomeMetrics {
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  failed: number;
  suppressed: number;
}

const getTimeWindowStart = (timeWindow: string): Date | null => {
  if (timeWindow === 'lifetime' || timeWindow === 'all') return null;

  const now = new Date();
  const startDate = new Date(now);
  
  switch (timeWindow) {
    case '1h':
      startDate.setHours(startDate.getHours() - 1);
      break;
    case '24h':
      startDate.setDate(startDate.getDate() - 1);
      break;
    case '7d':
      startDate.setDate(startDate.getDate() - 7);
      break;
    case '30d':
      startDate.setDate(startDate.getDate() - 30);
      break;
    default:
      startDate.setDate(startDate.getDate() - 1);
  }
  
  return startDate;
};

const aggregateMetricsData = (
  messageMetrics: MessageOutcomeMetrics | null,
  eventMetrics: Array<{ _id: string; count: number }>,
  orphanEventsCount = 0
): MetricsData => {
  const metrics = {
    sent: messageMetrics?.sent || 0,
    delivered: messageMetrics?.delivered || 0,
    bounced: messageMetrics?.bounced || 0,
    complained: messageMetrics?.complained || 0,
    failed: messageMetrics?.failed || 0,
    suppressed: messageMetrics?.suppressed || 0,
    orphan_events: orphanEventsCount,
  };

  // Process event metrics (additional source)
  eventMetrics.forEach((item) => {
    switch (item._id) {
      case 'delivered':
        metrics.delivered = Math.max(metrics.delivered, item.count);
        break;
      case 'bounced':
        metrics.bounced = Math.max(metrics.bounced, item.count);
        break;
      case 'complained':
        metrics.complained = Math.max(metrics.complained, item.count);
        break;
      case 'failed':
        metrics.failed = Math.max(metrics.failed, item.count);
        break;
      case 'suppressed':
        metrics.suppressed = Math.max(metrics.suppressed, item.count);
        break;
      case 'sent':
        metrics.sent = Math.max(metrics.sent, item.count);
        break;
    }
  });

  // Calculate rates
  const total = metrics.sent || 1; // Avoid division by zero
  return {
    ...metrics,
    delivery_rate: (metrics.delivered / total) * 100,
    bounce_rate: (metrics.bounced / total) * 100,
    complaint_rate: (metrics.complained / total) * 100,
    failure_rate: (metrics.failed / total) * 100,
    suppression_rate: (metrics.suppressed / total) * 100,
    orphan_event_rate: (metrics.orphan_events / total) * 100,
  };
};

// Efficient metrics calculation using database aggregation
const calculateMetrics = async (inboxId: string, timeWindow: string): Promise<TimeWindowMetrics> => {
  try {
    const messages = await getCollection('messages');
    const deliveryEvents = await getCollection('delivery_events');
    
    if (!messages || !deliveryEvents) {
      logger.error('Database collections not available');
      throw new Error('Required database collections not available');
    }

    const startDate = getTimeWindowStart(timeWindow);

    const msgMatch: Record<string, unknown> = { 'metadata.inbox_id': inboxId };
    const evtMatch: Record<string, unknown> = { inbox_id: inboxId };
    if (startDate) {
      msgMatch.created_at = { $gte: startDate.toISOString() };
      evtMatch.processed_at = { $gte: startDate.toISOString() };
    }
    
    const [messageMetricsResult, eventMetrics, orphanEventsCount] = await Promise.all([
      messages.aggregate([
        { $match: msgMatch },
        {
          $group: {
            _id: null,
            sent: { $sum: { $cond: [{ $eq: ['$direction', 'outbound'] }, 1, 0] } },
            delivered: { $sum: { $cond: [{ $eq: ['$metadata.delivery_status', 'delivered'] }, 1, 0] } },
            bounced: { $sum: { $cond: [{ $eq: ['$metadata.delivery_status', 'bounced'] }, 1, 0] } },
            complained: { $sum: { $cond: [{ $eq: ['$metadata.delivery_status', 'complained'] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ['$metadata.delivery_status', 'failed'] }, 1, 0] } },
            suppressed: { $sum: { $cond: [{ $eq: ['$metadata.delivery_status', 'suppressed'] }, 1, 0] } },
          },
        },
      ]).toArray(),
      
      deliveryEvents.aggregate([
        { $match: evtMatch },
        { $group: {
          _id: '$event_type',
          count: { $sum: 1 }
        }}
      ]).toArray(),
      deliveryEvents.countDocuments({ ...evtMatch, 'event_data.orphan': true }),
    ]);

    const messageMetrics = (messageMetricsResult?.[0] || null) as MessageOutcomeMetrics | null;
    const typedEventMetrics = (eventMetrics || []) as Array<{ _id: string; count: number }>;
    const metrics = aggregateMetricsData(messageMetrics, typedEventMetrics, orphanEventsCount || 0);
    
    return {
      ...metrics,
      time_window: timeWindow,
      calculated_at: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Error calculating metrics:', { error });
    throw error;
  }
};

// Get metrics for multiple time windows
const getMultiWindowMetrics = async (inboxId: string): Promise<{ [key: string]: TimeWindowMetrics }> => {
  const timeWindows = ['1h', '24h', '7d', '30d'];
  const metricsPromises = timeWindows.map(window => 
    calculateMetrics(inboxId, window).catch(error => {
      logger.error('Error calculating metrics for window', { window, error });
      return null;
    })
  );
  
  const results = await Promise.all(metricsPromises);
  const multiWindowMetrics: { [key: string]: TimeWindowMetrics } = {};
  
  timeWindows.forEach((window, index) => {
    if (results[index]) {
      multiWindowMetrics[window] = results[index];
    }
  });
  
  return multiWindowMetrics;
};

// Get domain-level metrics (aggregated across all inboxes)
const getDomainMetrics = async (domainId: string, timeWindow: string): Promise<TimeWindowMetrics> => {
  const messages = await getCollection('messages');
  const deliveryEvents = await getCollection('delivery_events');
  
  if (!messages || !deliveryEvents) {
    logger.error('Database collections not available');
    throw new Error('Required database collections not available');
  }

  const startDate = getTimeWindowStart(timeWindow);

  const msgMatch: Record<string, unknown> = { 'metadata.domain_id': domainId };
  const evtMatch: Record<string, unknown> = { domain_id: domainId };
  if (startDate) {
    msgMatch.created_at = { $gte: startDate.toISOString() };
    evtMatch.processed_at = { $gte: startDate.toISOString() };
  }
  
  try {
    const [messageMetricsResult, eventMetrics, orphanEventsCount] = await Promise.all([
      messages.aggregate([
        { $match: msgMatch },
        {
          $group: {
            _id: null,
            sent: { $sum: { $cond: [{ $eq: ['$direction', 'outbound'] }, 1, 0] } },
            delivered: { $sum: { $cond: [{ $eq: ['$metadata.delivery_status', 'delivered'] }, 1, 0] } },
            bounced: { $sum: { $cond: [{ $eq: ['$metadata.delivery_status', 'bounced'] }, 1, 0] } },
            complained: { $sum: { $cond: [{ $eq: ['$metadata.delivery_status', 'complained'] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ['$metadata.delivery_status', 'failed'] }, 1, 0] } },
            suppressed: { $sum: { $cond: [{ $eq: ['$metadata.delivery_status', 'suppressed'] }, 1, 0] } },
          },
        },
      ]).toArray(),
      
      deliveryEvents.aggregate([
        { $match: evtMatch },
        { $group: {
          _id: '$event_type',
          count: { $sum: 1 }
        }}
      ]).toArray(),
      deliveryEvents.countDocuments({ ...evtMatch, 'event_data.orphan': true }),
    ]);

    const messageMetrics = (messageMetricsResult?.[0] || null) as MessageOutcomeMetrics | null;
    const typedEventMetrics = (eventMetrics || []) as Array<{ _id: string; count: number }>;
    const metrics = aggregateMetricsData(messageMetrics, typedEventMetrics, orphanEventsCount || 0);
    
    return {
      ...metrics,
      time_window: timeWindow,
      calculated_at: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Error calculating domain metrics:', { error });
    throw error;
  }
};

export default {
  calculateMetrics,
  getMultiWindowMetrics,
  getDomainMetrics
};
