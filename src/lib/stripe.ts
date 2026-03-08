import Stripe from 'stripe';
import logger from '../utils/logger';

let stripeInstance: Stripe | null = null;

export function getStripe(): Stripe | null {
  if (!process.env.STRIPE_SECRET_KEY) {
    return null;
  }
  if (!stripeInstance) {
    stripeInstance = new Stripe(process.env.STRIPE_SECRET_KEY);
    logger.info('Stripe client initialized');
  }
  return stripeInstance;
}

export const COMMUNE_PLANS = {
  free: {
    name: 'Free',
    monthlyPrice: 0,
    yearlyPrice: 0,
    stripePriceIds: {
      monthly: null as string | null,
      yearly: null as string | null,
    },
    features: [
      'Shared domain (commune.email)',
      '2 agent inboxes',
      '20 emails/inbox/day',
      '50 emails/day total',
      '100 MB attachment storage',
      'TypeScript SDK + REST API',
      'Webhook delivery',
      'Community support',
    ],
  },
  agent_pro: {
    name: 'Agent Pro',
    monthlyPrice: 20,
    yearlyPrice: 16,
    stripePriceIds: {
      monthly: process.env.STRIPE_PRICE_AGENT_PRO_MONTHLY || null,
      yearly: process.env.STRIPE_PRICE_AGENT_PRO_YEARLY || null,
    },
    features: [
      '25 agent inboxes',
      '3 custom domains',
      '100 emails/inbox/day',
      '1,000 emails/day total',
      '1 GB attachment storage',
      'Semantic search',
      'Structured data extraction',
      'Sender reputation management',
      'Prompt injection protection',
      'Encryption at rest',
      'Per-inbox & API key limits',
      'Priority support',
    ],
  },
  business: {
    name: 'Business',
    monthlyPrice: 150,
    yearlyPrice: 120,
    stripePriceIds: {
      monthly: process.env.STRIPE_PRICE_BUSINESS_MONTHLY || null,
      yearly: process.env.STRIPE_PRICE_BUSINESS_YEARLY || null,
    },
    features: [
      '100 agent inboxes',
      '10 custom domains',
      '500 emails/inbox/day',
      '5,000 emails/day total',
      '5 GB attachment storage',
      'Everything in Agent Pro',
      'Conversation network graph',
      'Domain warmup',
      'Circuit breaker protection',
      'Attachment scanning (ClamAV)',
      'Dedicated support',
    ],
  },
  enterprise: {
    name: 'Enterprise',
    monthlyPrice: null as number | null,
    yearlyPrice: null as number | null,
    stripePriceIds: {
      monthly: process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY || null,
      yearly: process.env.STRIPE_PRICE_ENTERPRISE_YEARLY || null,
    },
    features: [
      'Unlimited everything',
      'Custom deployment',
      'Managed domain warmup',
      'Audit logging',
      'SSO & SAML',
      'Team management',
      'SLA guarantees',
      'Dedicated support manager',
      'Custom AI model training',
    ],
  },
};

export type CommunePlan = keyof typeof COMMUNE_PLANS;
export type BillingCycle = 'monthly' | 'yearly';

export function getPlanFromPriceId(priceId: string): CommunePlan | null {
  for (const [planKey, planConfig] of Object.entries(COMMUNE_PLANS)) {
    if (planConfig.stripePriceIds.monthly === priceId || planConfig.stripePriceIds.yearly === priceId) {
      return planKey as CommunePlan;
    }
  }
  return null;
}

export function getBillingCycleFromInterval(interval?: string | null): BillingCycle {
  if (interval === 'year') return 'yearly';
  return 'monthly';
}
