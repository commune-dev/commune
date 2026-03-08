import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import healthRoutes from './routes/health';
import statusRoutes from './routes/status';
import webhookRoutes from './routes/webhooks';
import domainRoutes from './routes/dashboard/domains';
import inboxRoutes from './routes/dashboard/inboxes';
import messageRoutes from './routes/dashboard/messages';
import authRoutes from './routes/dashboard/auth';
import apiKeyRoutes from './routes/dashboard/apiKeys';
import organizationRoutes from './routes/dashboard/organizations';
import adminRoutes from './routes/dashboard/admin';
import searchRoutes from './routes/dashboard/search';
import spamRoutes from './routes/dashboard/spam';
import attachmentRoutes from './routes/dashboard/attachments';
import billingRoutes from './routes/dashboard/billing';
import graphRoutes from './routes/dashboard/graph';
import phoneSettingsRoutes from './routes/dashboard/phoneSettings';
import phoneNumberRoutes from './routes/v1/phoneNumbers';
import smsRoutes from './routes/v1/sms';
import stripeWebhookRoutes from './routes/webhooks/stripe';
import twilioWebhookRoutes from './routes/webhooks/twilio';
import v1Routes from './routes/v1/index';
import unsubscribeRoutes from './routes/v1/unsubscribe';
import startup from './startup';
import { combinedAuth } from './middleware/combinedAuth';
import { jwtAuth } from './middleware/jwtAuth';
import { attachApiContext } from './middleware/attachApiContext';
import { errorHandler } from './middleware/errorHandler';
import { auditLog } from './middleware/auditLog';
import { securityHeaders, requestId, extraSecurityHeaders } from './middleware/securityHeaders';
import logger from './utils/logger';
import { getRedisClient, disconnectRedis, disconnectSubClient } from './lib/redis';
import { disconnectDB } from './db';
import { validateSecurityConfig } from './boot/securityBootstrap';
import { ensureEncryptionKeyIntegrity } from './lib/encryptionKeyGuard';
import TokenGuard from './lib/tokenGuard';
import webhookDeliveryService from './services/webhookDeliveryService';
import realtimeService from './services/realtimeService';
import { attachVoiceWS, activeCalls } from './services/voice/voiceBridgeService';
import * as callStore from './stores/callStore';
import { runAllIndexCreation } from './boot/ensureIndexes';
import { startInboundEmailWorker } from './workers/inboundEmailWorker';
import { startWebhookFanoutWorker } from './workers/webhookFanoutWorker';
import { startOutboundEmailWorker, closeOutboundEmailConnections } from './workers/outboundEmailWorker';
import { connect } from './db';
import type { Worker } from 'bullmq';

// ─── Worker references (for graceful shutdown) ─────────────────
const workerRefs: { inbound: Worker | null; fanout: Worker | null; outbound: Worker | null } = {
  inbound: null,
  fanout: null,
  outbound: null,
};

// ─── Security Bootstrap ────────────────────────────────────────
const securityCheck = validateSecurityConfig();
if (securityCheck.errors.length > 0 && process.env.NODE_ENV === 'production') {
  logger.error('FATAL: Security configuration errors in production', { errors: securityCheck.errors });
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 8000;
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:3001').split(',');

app.set('trust proxy', 1);
app.disable('x-powered-by');

logger.info('Email server starting', { port: PORT, nodeEnv: process.env.NODE_ENV, encryptionEnabled: securityCheck.encryptionEnabled });

// ─── CORS ────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.map((value) => value.trim()).includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Upgrade');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
});

// ─── Compression ─────────────────────────────────────────────────
app.use(compression({
  level: 6,
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers.accept === 'text/event-stream') return false;
    return compression.filter(req, res);
  },
}));

// ─── Security Headers & Audit ────────────────────────────────────
app.use(requestId);
app.use(securityHeaders);
app.use(extraSecurityHeaders);
app.use(auditLog);

// ─── Public routes (no auth, no JSON parser) ─────────────────────
app.use(healthRoutes);
app.use(statusRoutes);
app.use('/unsubscribe', unsubscribeRoutes);

// Webhook routes mounted BEFORE JSON parser to preserve raw body for signature verification
app.use('/api/webhooks/resend', webhookRoutes);
app.use('/api/webhooks', express.raw({ type: 'application/json' }), stripeWebhookRoutes);

// Twilio webhooks: urlencoded body (NOT JSON) — must be before express.json()
app.use('/api/webhooks/twilio', express.urlencoded({ extended: false }), twilioWebhookRoutes);

// ─── JSON parser for all remaining routes ────────────────────────
app.use(express.json({ limit: '10mb' }));

// ─── Auth routes ─────────────────────────────────────────────────
app.use(authRoutes);
app.use('/auth', authRoutes);
app.use('/api/auth', authRoutes);

// ─── Organization & API key management ───────────────────────────
app.use('/api/organizations', organizationRoutes);
app.use('/api/api-keys', apiKeyRoutes);

// ─── Dashboard API (JWT or API key auth) ─────────────────────────
app.use('/api', combinedAuth, attachApiContext, domainRoutes);
app.use('/api', combinedAuth, attachApiContext, inboxRoutes);
app.use('/api', combinedAuth, attachApiContext, messageRoutes);
app.use('/api/search', combinedAuth, attachApiContext, searchRoutes);
app.use('/api/attachments', combinedAuth, attachApiContext, attachmentRoutes);
app.use('/api/spam', combinedAuth, attachApiContext, spamRoutes);
app.use('/api', combinedAuth, attachApiContext, billingRoutes);
app.use('/api', combinedAuth, attachApiContext, graphRoutes);
app.use('/api', combinedAuth, attachApiContext, phoneSettingsRoutes);
app.use('/api/phone-numbers', combinedAuth, attachApiContext, phoneNumberRoutes);
app.use('/api/sms', combinedAuth, attachApiContext, smsRoutes);
app.use('/api/admin', jwtAuth, adminRoutes);

// ─── Public API v1 (API key auth only) ──────────────────────────
app.use('/v1', v1Routes);

// ─── OpenAPI spec (public, no auth) ─────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-var-requires
import openapiSpec from './openapi.json';
app.get('/openapi.json', (_req, res) => {
  res.json(openapiSpec);
});

// ─── Error handler (must be last) ───────────────────────────────
app.use(errorHandler);

// ─── Start server ───────────────────────────────────────────────
const httpServer = app.listen(PORT, () => {
  logger.info('Server listening', {
    port: PORT,
    replicaId: process.env.RAILWAY_REPLICA_ID,
    region: process.env.RAILWAY_REPLICA_REGION,
  });

  // Voice WS bridge must be attached BEFORE realtimeService so it gets first shot
  // at /ws/voice/* upgrade requests (realtimeService now skips those paths)
  attachVoiceWS(httpServer);

  // Attach WebSocket server for real-time notifications
  realtimeService.attachToServer(httpServer);

  // Encryption key guard — fatal if the key changed unexpectedly
  ensureEncryptionKeyIntegrity()
    .then(() => logger.info('Encryption key guard passed'))
    .catch((err) => {
      logger.error('Encryption key guard failed — shutting down', { error: err?.message || err });
      process.exit(1);
    });

  // Token guard — fatal if tokens changed unexpectedly
  TokenGuard.validateStartupTokens()
    .then(() => logger.info('Token guard passed'))
    .catch((err) => {
      logger.error('Token guard failed — shutting down', { error: err?.message || err });
      process.exit(1);
    });

  // Initialize monitoring and metrics scheduler
  startup.initializeMonitoring();

  // Initialize Redis (non-blocking)
  try {
    const redis = getRedisClient();
    if (redis) {
      logger.info('Redis client initialized');
    } else {
      logger.warn('Redis not configured — rate limiting will use in-memory fallback');
    }
  } catch (err) {
    logger.error('Redis initialization failed', { error: err });
  }

  // Run all database index creation in parallel (non-blocking)
  runAllIndexCreation().catch((err) => {
    logger.error('Index creation batch failed', { error: err });
  });

  // Start webhook delivery retry worker
  webhookDeliveryService.startRetryWorker();
  logger.info('Webhook delivery retry worker started');

  // Start BullMQ workers (inbound email processing + webhook fan-out + outbound email)
  workerRefs.inbound = startInboundEmailWorker();
  workerRefs.fanout = startWebhookFanoutWorker();
  workerRefs.outbound = startOutboundEmailWorker();

  // Pre-warm MongoDB connection pool
  connect().then(async (db) => {
    if (db) {
      await db.command({ ping: 1 });
      logger.info('MongoDB connection pool pre-warmed');
    }
  }).catch((err) => {
    logger.warn('MongoDB connection pool pre-warm failed', { error: err?.message || err });
  });
});

// Prevent 502s from Railway's Envoy proxy (Node.js default: 5s, Envoy keep-alive: 60s+)
httpServer.keepAliveTimeout = 65000;
httpServer.headersTimeout = 66000;

// ─── Graceful Shutdown ───────────────────────────────────────────
const shutdown = async (signal: string) => {
  logger.info(`${signal} received — starting graceful shutdown`);

  // Hang up all active voice calls and mark them failed in DB
  if (activeCalls.size > 0) {
    logger.info(`Closing ${activeCalls.size} active voice call(s)`);
    for (const [, call] of activeCalls) {
      try {
        call.twilioWs.close(1001, 'Server shutting down');
        call.openaiWs.close();
        if (call.callSid) {
          callStore.updateCallStatus(call.callSid, 'failed', { endedAt: new Date() }).catch(() => {});
        }
      } catch { /* ignore close errors during shutdown */ }
    }
  }

  httpServer.close(async () => {
    logger.info('HTTP server closed — draining connections');
    try {
      // Close BullMQ workers first so in-flight jobs complete before Redis disconnects
      await Promise.allSettled([
        workerRefs.inbound?.close(),
        workerRefs.fanout?.close(),
        workerRefs.outbound?.close(),
      ]);
      await closeOutboundEmailConnections();
      await disconnectDB();
      await disconnectRedis();
      await disconnectSubClient();
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown', { error: err });
      process.exit(1);
    }
  });

  // Force exit after 30s (matches railway.toml drainingSeconds)
  setTimeout(() => {
    logger.error('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 30000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
