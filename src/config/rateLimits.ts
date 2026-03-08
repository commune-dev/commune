export type TierType = 'free' | 'agent_pro' | 'business' | 'enterprise';

export interface TierLimits {
  emailsPerHour: number;
  emailsPerDay: number;
  emailsPerInboxPerDay: number;
  domainsPerDay: number;
  inboxesPerDay: number;
  maxInboxes: number;
  maxCustomDomains: number;
  attachmentStorageBytes: number;
  // Phone / SMS limits (top-level numeric — NOT inside features; hasFeature only works for booleans)
  maxPhoneNumbers: number;
  phoneCreditsIncluded: number;  // monthly included credits
  features: {
    semanticSearch: boolean;
    structuredExtraction: boolean;
    senderReputation: boolean;
    promptInjection: boolean;
    encryptionAtRest: boolean;
    manualLimits: boolean;
    domainWarmup: boolean;
    auditLogging: boolean;
    sso: boolean;
    networkGraph: boolean;
    smsMessaging: boolean;
    voiceCalling: boolean;
  };
  // Voice limits (numeric — not in features)
  maxConcurrentCalls: number;
  maxVoiceMinutesPerMonth: number;
}

export const RATE_LIMITS: Record<TierType, TierLimits> = {
  free: {
    emailsPerHour: 10,
    emailsPerDay: 50,
    emailsPerInboxPerDay: 20,
    domainsPerDay: 0,
    inboxesPerDay: 2,
    maxInboxes: 2,
    maxCustomDomains: 0,
    attachmentStorageBytes: 100 * 1024 * 1024, // 100 MB
    maxPhoneNumbers: 1,
    phoneCreditsIncluded: 200,
    maxConcurrentCalls: 0,
    maxVoiceMinutesPerMonth: 0,
    features: {
      semanticSearch: false,
      structuredExtraction: false,
      senderReputation: false,
      promptInjection: false,
      encryptionAtRest: false,
      manualLimits: false,
      domainWarmup: false,
      auditLogging: false,
      sso: false,
      networkGraph: false,
      smsMessaging: true,
      voiceCalling: false,
    },
  },
  agent_pro: {
    emailsPerHour: 200,
    emailsPerDay: 1000,
    emailsPerInboxPerDay: 100,
    domainsPerDay: 3,
    inboxesPerDay: 10,
    maxInboxes: 25,
    maxCustomDomains: 3,
    attachmentStorageBytes: 1 * 1024 * 1024 * 1024, // 1 GB
    maxPhoneNumbers: 5,
    phoneCreditsIncluded: 500,
    maxConcurrentCalls: 2,
    maxVoiceMinutesPerMonth: 100,
    features: {
      semanticSearch: true,
      structuredExtraction: true,
      senderReputation: true,
      promptInjection: true,
      encryptionAtRest: true,
      manualLimits: true,
      domainWarmup: false,
      auditLogging: false,
      sso: false,
      networkGraph: false,
      smsMessaging: true,
      voiceCalling: true,
    },
  },
  business: {
    emailsPerHour: 1000,
    emailsPerDay: 5000,
    emailsPerInboxPerDay: 500,
    domainsPerDay: 5,
    inboxesPerDay: 25,
    maxInboxes: 100,
    maxCustomDomains: 10,
    attachmentStorageBytes: 5 * 1024 * 1024 * 1024, // 5 GB
    maxPhoneNumbers: 25,
    phoneCreditsIncluded: 5000,
    maxConcurrentCalls: 10,
    maxVoiceMinutesPerMonth: 1000,
    features: {
      semanticSearch: true,
      structuredExtraction: true,
      senderReputation: true,
      promptInjection: true,
      encryptionAtRest: true,
      manualLimits: true,
      domainWarmup: true,
      auditLogging: false,
      sso: false,
      networkGraph: true,
      smsMessaging: true,
      voiceCalling: true,
    },
  },
  enterprise: {
    emailsPerHour: 5000,
    emailsPerDay: 25000,
    emailsPerInboxPerDay: 1000,
    domainsPerDay: 10,
    inboxesPerDay: 50,
    maxInboxes: Infinity,
    maxCustomDomains: Infinity,
    attachmentStorageBytes: Infinity,
    maxPhoneNumbers: Infinity,
    phoneCreditsIncluded: Infinity,
    maxConcurrentCalls: Infinity,
    maxVoiceMinutesPerMonth: Infinity,
    features: {
      semanticSearch: true,
      structuredExtraction: true,
      senderReputation: true,
      promptInjection: true,
      encryptionAtRest: true,
      manualLimits: true,
      domainWarmup: true,
      auditLogging: true,
      sso: true,
      networkGraph: true,
      smsMessaging: true,
      voiceCalling: true,
    },
  },
};

export const getOrgTierLimits = (tier: TierType = 'free'): TierLimits => {
  return RATE_LIMITS[tier] || RATE_LIMITS.free;
};

export const hasFeature = (tier: TierType, feature: keyof TierLimits['features']): boolean => {
  const limits = getOrgTierLimits(tier);
  return limits.features[feature];
};
