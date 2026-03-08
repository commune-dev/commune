import logger from '../utils/logger';
import messageStore from '../stores/messageStore';
import apiKeyStore from '../stores/apiKeyStore';
import orgStore from '../stores/orgStore';
import userStore from '../stores/userStore';
import sessionStore from '../stores/sessionStore';
import verificationStore from '../stores/verificationStore';
import reputationStore from '../stores/reputationStore';
import blockedSpamStore from '../stores/blockedSpamStore';
import securityStore from '../stores/securityStore';
import threadMetadataStore from '../stores/threadMetadataStore';
import webhookDeliveryStore from '../stores/webhookDeliveryStore';
import { AttachmentScannerService } from '../services/security/attachmentScannerService';
import DomainWarmupService from '../services/domainWarmupService';
import { DmarcReportService } from '../services/dmarcReportService';
import { ensureAuditIndexes } from '../middleware/auditLog';
import deletionRequestStore from '../stores/deletionRequestStore';
import TokenGuard from '../lib/tokenGuard';
import { AgentIdentityStore } from '../stores/agentIdentityStore';
import { AgentSignupStore } from '../stores/agentSignupStore';
import * as callStore from '../stores/callStore';
import { ensureVoiceIndexes } from '../stores/voiceIndexes';

interface IndexTask {
  name: string;
  fn: () => Promise<void>;
}

/**
 * Run all ensureIndexes() calls in parallel using Promise.allSettled.
 * Non-blocking — failures are logged but don't crash the server.
 */
export const runAllIndexCreation = async (): Promise<void> => {
  const tasks: IndexTask[] = [
    { name: 'messageStore', fn: () => messageStore.ensureIndexes() },
    { name: 'apiKeyStore', fn: () => apiKeyStore.ensureIndexes() },
    { name: 'orgStore', fn: () => orgStore.ensureIndexes() },
    { name: 'userStore', fn: () => userStore.ensureIndexes() },
    { name: 'sessionStore', fn: () => sessionStore.ensureIndexes() },
    { name: 'verificationStore', fn: () => verificationStore.ensureIndexes() },
    { name: 'reputationStore', fn: () => reputationStore.ensureIndexes() },
    { name: 'blockedSpamStore', fn: () => blockedSpamStore.ensureIndexes() },
    { name: 'securityStore', fn: () => securityStore.ensureIndexes() },
    { name: 'threadMetadataStore', fn: () => threadMetadataStore.ensureIndexes() },
    { name: 'webhookDeliveryStore', fn: () => webhookDeliveryStore.ensureIndexes() },
    { name: 'attachmentScanner', fn: () => AttachmentScannerService.getInstance().ensureIndexes() },
    { name: 'domainWarmup', fn: () => DomainWarmupService.getInstance().ensureIndexes() },
    { name: 'dmarcReport', fn: () => DmarcReportService.getInstance().ensureIndexes() },
    { name: 'auditLog', fn: () => ensureAuditIndexes() },
    { name: 'deletionRequestStore', fn: () => deletionRequestStore.ensureIndexes() },
    { name: 'tokenGuard', fn: () => TokenGuard.ensureIndexes() },
    { name: 'agentIdentityStore', fn: () => AgentIdentityStore.ensureIndexes() },
    { name: 'agentSignupStore', fn: () => AgentSignupStore.ensureIndexes() },
    { name: 'callStore', fn: () => callStore.ensureIndexes() },
    { name: 'voiceIndexes', fn: () => ensureVoiceIndexes() },
  ];

  logger.info('Running database index creation', { count: tasks.length });

  const results = await Promise.allSettled(tasks.map(t => t.fn()));

  let succeeded = 0;
  let failed = 0;
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const task = tasks[i];
    if (result.status === 'fulfilled') {
      succeeded++;
    } else {
      failed++;
      logger.error(`Index creation failed: ${task.name}`, { error: result.reason?.message || result.reason });
    }
  }

  logger.info('Database index creation complete', { succeeded, failed, total: tasks.length });
};
