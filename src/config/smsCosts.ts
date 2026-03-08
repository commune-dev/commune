import type { CreditBundle } from '../types/phone';

// ─── Per-country SMS credit costs ───────────────────────────────
// 1 credit = $0.01. Twilio cost varies by country.
// Update this map when Twilio changes pricing for key markets.

export const COUNTRY_SMS_CREDITS: Record<string, { outbound: number; outboundMms: number; inbound: number }> = {
  // North America
  US: { outbound: 2,  outboundMms: 5,  inbound: 1 },
  CA: { outbound: 2,  outboundMms: 5,  inbound: 1 },
  // UK
  GB: { outbound: 8,  outboundMms: 12, inbound: 2 },
  // Western Europe
  DE: { outbound: 10, outboundMms: 15, inbound: 2 },
  FR: { outbound: 10, outboundMms: 15, inbound: 2 },
  ES: { outbound: 10, outboundMms: 15, inbound: 2 },
  IT: { outbound: 10, outboundMms: 15, inbound: 2 },
  NL: { outbound: 10, outboundMms: 15, inbound: 2 },
  SE: { outbound: 10, outboundMms: 15, inbound: 2 },
  NO: { outbound: 10, outboundMms: 15, inbound: 2 },
  CH: { outbound: 10, outboundMms: 15, inbound: 2 },
  // APAC
  AU: { outbound: 8,  outboundMms: 12, inbound: 2 },
  NZ: { outbound: 8,  outboundMms: 12, inbound: 2 },
  JP: { outbound: 10, outboundMms: 15, inbound: 3 },
  SG: { outbound: 6,  outboundMms: 10, inbound: 2 },
  IN: { outbound: 12, outboundMms: 18, inbound: 3 },
  // Latin America
  BR: { outbound: 15, outboundMms: 22, inbound: 4 },
  MX: { outbound: 12, outboundMms: 18, inbound: 3 },
  CO: { outbound: 15, outboundMms: 22, inbound: 4 },
  // Africa / Middle East (high-cost regions)
  ZA: { outbound: 15, outboundMms: 22, inbound: 4 },
  NG: { outbound: 20, outboundMms: 30, inbound: 5 },
  KE: { outbound: 22, outboundMms: 33, inbound: 5 },
  SA: { outbound: 20, outboundMms: 30, inbound: 5 },
  AE: { outbound: 18, outboundMms: 27, inbound: 4 },
};

// Default for countries not in the map
const DEFAULT_CREDITS = { outbound: 20, outboundMms: 30, inbound: 5 };

/**
 * Get the credit cost for an SMS/MMS message.
 * country — ISO-3166 alpha-2 country code extracted from E.164 number
 */
export function getCreditCost(
  country: string,
  direction: 'inbound' | 'outbound',
  type: 'sms' | 'mms' = 'sms'
): number {
  const costs = COUNTRY_SMS_CREDITS[country.toUpperCase()] ?? DEFAULT_CREDITS;
  if (direction === 'inbound') return costs.inbound;
  return type === 'mms' ? costs.outboundMms : costs.outbound;
}

/**
 * Extract ISO country code from an E.164 phone number.
 * Uses basic prefix matching for common countries.
 * For production accuracy, use a libphonenumber library.
 */
export function getCountryFromE164(phoneNumber: string): string {
  if (!phoneNumber.startsWith('+')) return 'US';
  const n = phoneNumber.slice(1);
  // +1 = US/CA (check area code for CA, default US)
  if (n.startsWith('1')) return 'US';
  if (n.startsWith('44')) return 'GB';
  if (n.startsWith('49')) return 'DE';
  if (n.startsWith('33')) return 'FR';
  if (n.startsWith('34')) return 'ES';
  if (n.startsWith('39')) return 'IT';
  if (n.startsWith('31')) return 'NL';
  if (n.startsWith('46')) return 'SE';
  if (n.startsWith('47')) return 'NO';
  if (n.startsWith('41')) return 'CH';
  if (n.startsWith('61')) return 'AU';
  if (n.startsWith('64')) return 'NZ';
  if (n.startsWith('81')) return 'JP';
  if (n.startsWith('65')) return 'SG';
  if (n.startsWith('91')) return 'IN';
  if (n.startsWith('55')) return 'BR';
  if (n.startsWith('52')) return 'MX';
  if (n.startsWith('57')) return 'CO';
  if (n.startsWith('27')) return 'ZA';
  if (n.startsWith('234')) return 'NG';
  if (n.startsWith('254')) return 'KE';
  if (n.startsWith('966')) return 'SA';
  if (n.startsWith('971')) return 'AE';
  return 'US'; // conservative default
}

// ─── Phone number rental cost ────────────────────────────────────
export const PHONE_NUMBER_MONTHLY_CREDITS = 150;

// ─── Stripe credit add-on bundles ────────────────────────────────
export const CREDIT_BUNDLES: Record<string, CreditBundle> = {
  starter: {
    credits: 1000,
    price: 12,
    stripePriceId: process.env.STRIPE_PRICE_CREDITS_STARTER || null,
  },
  growth: {
    credits: 5000,
    price: 55,
    stripePriceId: process.env.STRIPE_PRICE_CREDITS_GROWTH || null,
  },
  scale: {
    credits: 20000,
    price: 200,
    stripePriceId: process.env.STRIPE_PRICE_CREDITS_SCALE || null,
  },
};

// Monthly included credits per plan (used by invoice.paid handler)
export const PLAN_PHONE_CREDITS: Record<string, number> = {
  free: 200,
  agent_pro: 500,
  business: 5000,
  enterprise: Infinity,
};
