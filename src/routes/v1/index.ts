import { Router } from 'express';
import { v1CombinedAuth } from '../../middleware/agentSignatureAuth';
import agentAuthRoutes from './agentAuth';
import agentManagementRoutes from './agentManagement';
import domainRoutes from './domains';
import inboxRoutes from './inboxes';
import threadRoutes from './threads';
import messageRoutes from './messages';
import attachmentRoutes from './attachments';
import dmarcRoutes from './dmarc';
import deliveryMetricsRoutes from './deliveryMetrics';
import searchRoutes from './search';
import webhookDeliveryRoutes from './webhookDeliveries';
import dataDeletionRoutes from './dataDeletion';
import phoneNumberRoutes from './phoneNumbers';
import smsRoutes from './sms';
import creditsRoutes from './credits';
import toolsRoutes from './tools';
import callsRoutes from './calls';
import voiceAgentRoutes from './voiceAgents';
import eventsRouter from './events';
import meRoutes from './me';
import feedbackRoutes from './feedback';

const router = Router();

// Agent registration endpoints — no auth required (they ARE the auth bootstrap)
router.use('/auth', agentAuthRoutes);

// All other v1 routes require authentication.
// Accepts EITHER:
//   Authorization: Bearer comm_xxx...        (existing API key)
//   Authorization: Agent agt_xxx:base64sig   (new Ed25519 agent signing)
router.use(v1CombinedAuth);

// Attach apiKey context for permission checks (backward compat)
router.use((req: any, _res, next) => {
  if (!req.apiKey || typeof req.apiKey === 'string') {
    const orgId = req.orgId ?? null;
    req.apiKey = { orgId, source: req.authType ?? 'apikey' };
  }
  next();
});

// Agent self-service management (API keys, org settings) — requires auth
router.use('/agent', agentManagementRoutes);

router.use('/domains', domainRoutes);
router.use('/inboxes', inboxRoutes);
router.use('/domains', inboxRoutes);
router.use('/threads', threadRoutes);
router.use('/messages', messageRoutes);
router.use('/attachments', attachmentRoutes);
router.use('/dmarc', dmarcRoutes);
router.use('/delivery', deliveryMetricsRoutes);
router.use('/search', searchRoutes);
router.use('/webhooks', webhookDeliveryRoutes);
router.use('/data', dataDeletionRoutes);
router.use('/phone-numbers', phoneNumberRoutes);
router.use('/sms', smsRoutes);
router.use('/credits', creditsRoutes);
router.use('/tools', toolsRoutes);
router.use('/calls', callsRoutes);
router.use('/phone-numbers', voiceAgentRoutes);
router.use('/events', eventsRouter);
router.use('/me', meRoutes);
router.use('/feedback', feedbackRoutes);

export default router;
