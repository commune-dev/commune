import crypto from 'crypto';
import webhookDeliveryStore from '../stores/webhookDeliveryStore';
import type { WebhookDeliveryAttempt, WebhookDeliveryStatus } from '../types';
import logger from '../utils/logger';
import { getRedisClient } from '../lib/redis';

// ─── Configuration ──────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = Number(process.env.WEBHOOK_MAX_ATTEMPTS || 8);
const FIRST_ATTEMPT_TIMEOUT_MS = Number(process.env.WEBHOOK_FIRST_TIMEOUT_MS || 10000);
const RETRY_TIMEOUT_MS = Number(process.env.WEBHOOK_RETRY_TIMEOUT_MS || 30000);
const RETRY_WORKER_INTERVAL_MS = Number(process.env.WEBHOOK_RETRY_INTERVAL_MS || 5000);
const RETRY_BATCH_SIZE = Number(process.env.WEBHOOK_RETRY_BATCH_SIZE || 20);
const CIRCUIT_BREAKER_THRESHOLD = Number(process.env.WEBHOOK_CB_THRESHOLD || 5);
const CIRCUIT_BREAKER_COOLDOWN_MS = Number(process.env.WEBHOOK_CB_COOLDOWN_MS || 5 * 60 * 1000);

// Retry backoff schedule in seconds: 5s, 30s, 2min, 10min, 30min, 1hr, 2hr, 4hr
const RETRY_DELAYS_S = [5, 30, 120, 600, 1800, 3600, 7200, 14400];

// ─── Circuit Breaker (per endpoint) ─────────────────────────────────────────────

interface CircuitState {
  consecutive_failures: number;
  open_until: number; // timestamp ms, 0 = closed
}

const circuitBreakers = new Map<string, CircuitState>();

const getCircuit = (endpoint: string): CircuitState => {
  let state = circuitBreakers.get(endpoint);
  if (!state) {
    state = { consecutive_failures: 0, open_until: 0 };
    circuitBreakers.set(endpoint, state);
  }
  return state;
};

const isCircuitOpen = (endpoint: string): boolean => {
  const state = getCircuit(endpoint);
  if (state.open_until === 0) return false;
  if (Date.now() >= state.open_until) {
    // Half-open: allow one attempt
    state.open_until = 0;
    return false;
  }
  return true;
};

const recordSuccess = (endpoint: string): void => {
  const state = getCircuit(endpoint);
  state.consecutive_failures = 0;
  state.open_until = 0;
};

const recordFailure = (endpoint: string): void => {
  const state = getCircuit(endpoint);
  state.consecutive_failures++;
  if (state.consecutive_failures >= CIRCUIT_BREAKER_THRESHOLD) {
    state.open_until = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
    logger.warn('Circuit breaker OPEN for endpoint', { endpoint, consecutiveFailures: state.consecutive_failures, cooldownSeconds: CIRCUIT_BREAKER_COOLDOWN_MS / 1000 });
  }
};

// ─── Helpers ────────────────────────────────────────────────────────────────────

const computePayloadHash = (payload: Record<string, any>): string => {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
};

const computeSignature = (body: string, timestamp: string, secret: string): string => {
  return `v1=${crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`, 'utf8')
    .digest('hex')}`;
};

const calculateRetryAt = (attemptNumber: number): string => {
  const delayIdx = Math.min(attemptNumber - 1, RETRY_DELAYS_S.length - 1);
  const baseDelay = RETRY_DELAYS_S[delayIdx];
  // Add jitter: ±25% of base delay
  const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1);
  const delayMs = (baseDelay + jitter) * 1000;
  return new Date(Date.now() + delayMs).toISOString();
};

// ─── Core Delivery ──────────────────────────────────────────────────────────────

interface DeliverResult {
  success: boolean;
  status_code: number | null;
  error: string | null;
  latency_ms: number;
}

const attemptDelivery = async (
  endpoint: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<DeliverResult> => {
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const latency = Date.now() - start;

    // 2xx = success, anything else = failure
    if (response.ok) {
      return { success: true, status_code: response.status, error: null, latency_ms: latency };
    }

    // Read response body for error context (truncated)
    let errorBody = '';
    try {
      errorBody = (await response.text()).slice(0, 500);
    } catch { /* ignore */ }

    return {
      success: false,
      status_code: response.status,
      error: `HTTP ${response.status}: ${errorBody || response.statusText}`,
      latency_ms: latency,
    };
  } catch (err: any) {
    const latency = Date.now() - start;
    const errorMsg = err.name === 'AbortError'
      ? `Timeout after ${timeoutMs}ms`
      : err.message || 'Unknown error';

    return { success: false, status_code: null, error: errorMsg, latency_ms: latency };
  }
};

// ─── Public API ─────────────────────────────────────────────────────────────────

/**
 * Deliver a webhook with guaranteed delivery.
 * 
 * 1. Persist delivery record to MongoDB
 * 2. Attempt inline delivery (fast path — no queue delay)
 * 3. On failure: schedule for retry with exponential backoff
 * 
 * Returns the delivery_id for tracking.
 */
const deliverWebhook = async (params: {
  inbox_id: string;
  org_id?: string;
  message_id: string;
  endpoint: string;
  payload: Record<string, any>;
  webhook_secret?: string;
}): Promise<{ delivery_id: string; delivered: boolean }> => {
  const { inbox_id, org_id, message_id, endpoint, payload, webhook_secret } = params;

  // Build signed headers
  const body = JSON.stringify(payload);
  const timestamp = Date.now().toString();
  const signature = webhook_secret ? computeSignature(body, timestamp, webhook_secret) : null;
  const payloadHash = computePayloadHash(payload);

  // Create persistent delivery record FIRST (guarantees we never lose the webhook)
  const delivery = await webhookDeliveryStore.createDelivery({
    inbox_id,
    org_id,
    message_id,
    endpoint,
    payload,
    payload_hash: payloadHash,
    max_attempts: MAX_ATTEMPTS,
    signature_header: signature,
    webhook_secret: webhook_secret || null,
  });

  const deliveryId = delivery.delivery_id;

  // Build headers for the HTTP request
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-commune-delivery-id': deliveryId,
    'x-commune-timestamp': timestamp,
    'x-commune-attempt': '1',
  };
  if (signature) {
    headers['x-commune-signature'] = signature;
  }

  // Check circuit breaker
  if (isCircuitOpen(endpoint)) {
    logger.info('Circuit breaker open, skipping inline attempt, queuing for retry', { endpoint });
    const retryAt = calculateRetryAt(1);
    await webhookDeliveryStore.recordAttempt(deliveryId, {
      attempt: 1,
      status_code: null,
      error: 'Circuit breaker open — endpoint temporarily disabled',
      latency_ms: 0,
      attempted_at: new Date().toISOString(),
    }, {
      status: 'retrying',
      next_retry_at: retryAt,
    });
    return { delivery_id: deliveryId, delivered: false };
  }

  // Attempt inline delivery (fast path)
  const result = await attemptDelivery(endpoint, body, headers, FIRST_ATTEMPT_TIMEOUT_MS);

  const attempt: WebhookDeliveryAttempt = {
    attempt: 1,
    status_code: result.status_code,
    error: result.error,
    latency_ms: result.latency_ms,
    attempted_at: new Date().toISOString(),
  };

  if (result.success) {
    // Happy path: delivered on first try
    recordSuccess(endpoint);
    await webhookDeliveryStore.recordAttempt(deliveryId, attempt, {
      status: 'delivered',
      next_retry_at: null,
      delivered_at: new Date().toISOString(),
      delivery_latency_ms: result.latency_ms,
    });

    logger.info('Webhook delivered on first attempt', {
      deliveryId,
      endpoint,
      latency_ms: result.latency_ms,
      statusCode: result.status_code,
    });

    return { delivery_id: deliveryId, delivered: true };
  }

  // First attempt failed — schedule retry
  recordFailure(endpoint);
  const retryAt = calculateRetryAt(1);

  if (1 >= MAX_ATTEMPTS) {
    // Only 1 attempt configured — go straight to dead
    await webhookDeliveryStore.recordAttempt(deliveryId, attempt, {
      status: 'dead',
      next_retry_at: null,
      dead_at: new Date().toISOString(),
    });
    logger.error('Webhook dead after 1 attempt', { deliveryId, endpoint, error: result.error });
    return { delivery_id: deliveryId, delivered: false };
  }

  await webhookDeliveryStore.recordAttempt(deliveryId, attempt, {
    status: 'retrying',
    next_retry_at: retryAt,
  });

  logger.warn('Webhook delivery failed, scheduled retry', {
    deliveryId,
    endpoint,
    error: result.error,
    statusCode: result.status_code,
    nextRetryAt: retryAt,
    latencyMs: result.latency_ms,
  });

  return { delivery_id: deliveryId, delivered: false };
};

// ─── Retry Worker ───────────────────────────────────────────────────────────────

let retryWorkerHandle: ReturnType<typeof setInterval> | null = null;
let isProcessingRetries = false;

const processRetryBatch = async (): Promise<number> => {
  if (isProcessingRetries) return 0;
  isProcessingRetries = true;

  try {
    // Atomically claim a batch of deliveries ready for retry
    const batch = await webhookDeliveryStore.claimRetryBatch(RETRY_BATCH_SIZE);
    if (batch.length === 0) return 0;

    let processed = 0;

    for (const delivery of batch) {
      const attemptNumber = delivery.attempt_count + 1;
      const endpoint = delivery.endpoint;

      // Re-sign with fresh timestamp using stored webhook secret
      const body = JSON.stringify(delivery.payload);
      const timestamp = Date.now().toString();
      const signature = delivery.webhook_secret
        ? computeSignature(body, timestamp, delivery.webhook_secret)
        : null;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-commune-delivery-id': delivery.delivery_id,
        'x-commune-timestamp': timestamp,
        'x-commune-attempt': attemptNumber.toString(),
      };
      if (signature) {
        headers['x-commune-signature'] = signature;
      }

      // Check circuit breaker
      if (isCircuitOpen(endpoint)) {
        const retryAt = calculateRetryAt(attemptNumber);
        await webhookDeliveryStore.recordAttempt(delivery.delivery_id, {
          attempt: attemptNumber,
          status_code: null,
          error: 'Circuit breaker open',
          latency_ms: 0,
          attempted_at: new Date().toISOString(),
        }, {
          status: 'retrying',
          next_retry_at: retryAt,
        });
        continue;
      }

      const result = await attemptDelivery(endpoint, body, headers, RETRY_TIMEOUT_MS);

      const attempt: WebhookDeliveryAttempt = {
        attempt: attemptNumber,
        status_code: result.status_code,
        error: result.error,
        latency_ms: result.latency_ms,
        attempted_at: new Date().toISOString(),
      };

      if (result.success) {
        recordSuccess(endpoint);
        const totalLatency = Date.now() - new Date(delivery.created_at).getTime();
        await webhookDeliveryStore.recordAttempt(delivery.delivery_id, attempt, {
          status: 'delivered',
          next_retry_at: null,
          delivered_at: new Date().toISOString(),
          delivery_latency_ms: totalLatency,
        });

        logger.info('Webhook delivered on retry', {
          deliveryId: delivery.delivery_id,
          endpoint,
          attempt: attemptNumber,
          latency_ms: result.latency_ms,
          totalLatency_ms: totalLatency,
        });
      } else {
        recordFailure(endpoint);

        if (attemptNumber >= delivery.max_attempts) {
          // Max retries exhausted → dead letter
          await webhookDeliveryStore.recordAttempt(delivery.delivery_id, attempt, {
            status: 'dead',
            next_retry_at: null,
            dead_at: new Date().toISOString(),
          });

          logger.error('Webhook dead after max attempts', {
            deliveryId: delivery.delivery_id,
            endpoint,
            attempts: attemptNumber,
            lastError: result.error,
          });
        } else {
          // Schedule next retry
          const retryAt = calculateRetryAt(attemptNumber);
          await webhookDeliveryStore.recordAttempt(delivery.delivery_id, attempt, {
            status: 'retrying',
            next_retry_at: retryAt,
          });

          logger.warn('Webhook retry attempt failed', {
            deliveryId: delivery.delivery_id,
            endpoint,
            attempt: `${attemptNumber}/${delivery.max_attempts}`,
            error: result.error,
            nextRetryAt: retryAt,
          });
        }
      }

      processed++;
    }

    return processed;
  } catch (err) {
    logger.error('Retry worker error', { error: err });
    return 0;
  } finally {
    isProcessingRetries = false;
  }
};

/**
 * Start the in-process retry worker.
 * Polls MongoDB every RETRY_WORKER_INTERVAL_MS for deliveries ready to retry.
 */
const startRetryWorker = (): void => {
  if (retryWorkerHandle) {
    logger.warn('Retry worker already running');
    return;
  }

  logger.info('Webhook retry worker started', {
    interval: RETRY_WORKER_INTERVAL_MS,
    batchSize: RETRY_BATCH_SIZE,
    maxAttempts: MAX_ATTEMPTS,
    retrySchedule: RETRY_DELAYS_S,
  });

  retryWorkerHandle = setInterval(async () => {
    try {
      const redis = getRedisClient();
      if (redis) {
        const replicaId = process.env.RAILWAY_REPLICA_ID || `local-${process.pid}`;
        const lockKey = 'webhook:retry:leader';
        const lockTtl = RETRY_WORKER_INTERVAL_MS + 5000; // interval + buffer

        const acquired = await redis.set(lockKey, replicaId, 'PX', lockTtl, 'NX');
        if (!acquired) {
          return; // another replica is handling this cycle
        }
      }

      const processed = await processRetryBatch();
      if (processed > 0) {
        logger.debug('Retry worker processed deliveries', { count: processed });
      }
    } catch (err) {
      logger.error('Retry worker tick error', { error: err });
    }
  }, RETRY_WORKER_INTERVAL_MS);

  // Don't block process exit
  if (retryWorkerHandle.unref) {
    retryWorkerHandle.unref();
  }
};

const stopRetryWorker = (): void => {
  if (retryWorkerHandle) {
    clearInterval(retryWorkerHandle);
    retryWorkerHandle = null;
    logger.info('Webhook retry worker stopped');
  }
};

/**
 * Manual retry of a specific delivery (for dead letter replay).
 */
const retryDelivery = async (deliveryId: string): Promise<{ success: boolean; error?: string }> => {
  const delivery = await webhookDeliveryStore.getDelivery(deliveryId);
  if (!delivery) {
    return { success: false, error: 'Delivery not found' };
  }

  if (delivery.status === 'delivered') {
    return { success: false, error: 'Delivery already succeeded' };
  }

  // Requeue for the retry worker
  const requeued = await webhookDeliveryStore.requeue(deliveryId);
  if (!requeued) {
    return { success: false, error: 'Failed to requeue delivery' };
  }

  logger.info('Manual retry queued', { deliveryId });
  return { success: true };
};

export default {
  deliverWebhook,
  startRetryWorker,
  stopRetryWorker,
  retryDelivery,
  processRetryBatch,
};
