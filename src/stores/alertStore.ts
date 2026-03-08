import { getCollection } from '../db';
import logger from '../utils/logger';

interface CalculatedAlert {
  _id?: string;
  inbox_id: string;
  domain_id?: string;
  alert_type: 'high_bounce_rate' | 'suppression_growth' | 'low_delivery_rate' | 'high_complaint_rate' | 'high_failure_rate';
  severity: 'warning' | 'critical';
  value: number;
  threshold: number;
  time_window: string;
  calculated_at: string;
  expires_at: string;
}

const ensureIndexes = async () => {
  const collection = await getCollection<CalculatedAlert>('calculated_alerts');
  if (collection) {
    await collection.createIndex({ inbox_id: 1, alert_type: 1, calculated_at: -1 });
    await collection.createIndex({ calculated_at: 1 }, { expireAfterSeconds: 3600 }); // 1 hour TTL
  }
};

const storeAlert = async (alert: CalculatedAlert): Promise<string | null> => {
  try {
    const collection = await getCollection<CalculatedAlert>('calculated_alerts');
    if (!collection) return null;
    
    const result = await collection.insertOne({
      ...alert,
      _id: `${alert.inbox_id}-${alert.alert_type}-${Date.now()}`
    });
    
    return result.insertedId;
  } catch (error) {
    logger.error('Error storing alert:', { error });
    return null;
  }
};

const getAlerts = async (inboxId: string, timeWindow?: string): Promise<CalculatedAlert[]> => {
  try {
    const collection = await getCollection<CalculatedAlert>('calculated_alerts');
    if (!collection) return [];
    
    const query: any = { inbox_id: inboxId };
    
    if (timeWindow) {
      const startDate = new Date();
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
      }
      query.calculated_at = { $gte: startDate };
    }
    
    const alerts = await collection
      .find(query)
      .sort({ calculated_at: -1 })
      .limit(50)
      .toArray();
    
    return alerts;
  } catch (error) {
    logger.error('Error getting alerts:', { error });
    return [];
  }
};

export default {
  ensureIndexes,
  storeAlert,
  getAlerts
};
