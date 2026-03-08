import Redis from 'ioredis';
import logger from '../utils/logger';

let redisClient: Redis | null = null;
let isConnected = false;

const REDIS_URL = process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL;

export const getRedisClient = (): Redis | null => {
  if (redisClient && isConnected) {
    return redisClient;
  }

  if (!REDIS_URL) {
    return null;
  }

  if (redisClient) {
    return redisClient;
  }

  try {
    redisClient = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 5) {
          logger.warn('Redis: max retries reached, giving up');
          return null;
        }
        return Math.min(times * 200, 2000);
      },
      reconnectOnError(err) {
        const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
        return targetErrors.some((e) => err.message.includes(e));
      },
      connectTimeout: 5000,
      lazyConnect: false,
    });

    redisClient.on('connect', () => {
      isConnected = true;
      logger.info('Redis connected');
    });

    redisClient.on('error', (err) => {
      logger.error('Redis error', { error: err.message });
    });

    redisClient.on('close', () => {
      isConnected = false;
      logger.warn('Redis connection closed');
    });

    return redisClient;
  } catch (err) {
    logger.error('Redis client creation failed', { error: err });
    return null;
  }
};

export const isRedisAvailable = (): boolean => {
  return !!(redisClient && isConnected);
};

export const disconnectRedis = async (): Promise<void> => {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    isConnected = false;
  }
};

let subClient: Redis | null = null;

export const getSubClient = (): Redis | null => {
  if (subClient) return subClient;

  const url = process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL;
  if (!url) return null;

  try {
    subClient = new Redis(url, {
      maxRetriesPerRequest: null, // required for subscriber mode
      retryStrategy: (times) => Math.min(times * 500, 5000),
      lazyConnect: false,
    });

    subClient.on('connect', () => logger.info('Redis sub client connected'));
    subClient.on('error', (err) => logger.warn('Redis sub client error', { error: err.message }));
    subClient.on('close', () => logger.warn('Redis sub client disconnected'));

    return subClient;
  } catch (err) {
    logger.error('Redis sub client creation failed', { error: err });
    return null;
  }
};

export const disconnectSubClient = async (): Promise<void> => {
  if (subClient) {
    await subClient.quit();
    subClient = null;
  }
};

// BullMQ requires maxRetriesPerRequest: null on all blocking connections.
// Do NOT pass the main client (maxRetriesPerRequest: 3) to BullMQ Workers or Queues.
// Instead call getBullMQConnection() which creates a dedicated client with the right options.
export const getBullMQConnection = (): Redis | null => {
  const url = process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL;
  if (!url) return null;

  try {
    const conn = new Redis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      retryStrategy: (times) => Math.min(times * 500, 5000),
      lazyConnect: false,
    });
    conn.on('error', (err) => logger.warn('BullMQ redis error', { error: err.message }));
    return conn;
  } catch (err) {
    logger.error('BullMQ redis connection failed', { error: err });
    return null;
  }
};
