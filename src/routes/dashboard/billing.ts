import { Router, Request, Response } from 'express';
import { getStripe, COMMUNE_PLANS, getPlanFromPriceId, getBillingCycleFromInterval } from '../../lib/stripe';
import type { CommunePlan, BillingCycle } from '../../lib/stripe';
import { connect } from '../../db';
import { getOrgTierLimits } from '../../config/rateLimits';
import type { TierType } from '../../config/rateLimits';
import { CREDIT_BUNDLES } from '../../config/smsCosts';
import { creditStore } from '../../stores/creditStore';
import logger from '../../utils/logger';

const router = Router();

router.get('/billing/plans', async (_req: Request, res: Response) => {
  try {
    const plans = Object.entries(COMMUNE_PLANS).map(([key, config]) => ({
      id: key,
      name: config.name,
      monthlyPrice: config.monthlyPrice,
      yearlyPrice: config.yearlyPrice,
      features: config.features,
      limits: getOrgTierLimits(key as TierType),
    }));
    res.json({ plans });
  } catch (error: any) {
    logger.error('Error fetching plans', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch plans' });
  }
});

router.get('/billing/subscription', async (req: Request, res: Response) => {
  try {
    const orgId = (req as any).orgId;
    if (!orgId) return res.status(401).json({ error: 'Not authenticated' });

    const db = await connect();
    if (!db) return res.status(500).json({ error: 'Database unavailable' });
    const org = await db.collection('organizations').findOne({ id: orgId });
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    const tier = (org.tier || 'free') as TierType;
    const planConfig = COMMUNE_PLANS[tier as CommunePlan] || COMMUNE_PLANS.free;
    const tierLimits = getOrgTierLimits(tier);

    res.json({
      tier,
      billing_cycle: org.billing_cycle || 'monthly',
      stripe_customer_id: org.stripe_customer_id || null,
      stripe_subscription_id: org.stripe_subscription_id || null,
      plan_updated_at: org.plan_updated_at || null,
      plan_name: planConfig.name,
      features: planConfig.features,
      limits: tierLimits,
      usage: {
        attachment_storage_used_bytes: org.attachment_storage_used_bytes || 0,
        attachment_storage_limit_bytes: tierLimits.attachmentStorageBytes,
      },
    });
  } catch (error: any) {
    logger.error('Error fetching subscription', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch subscription' });
  }
});

router.post('/billing/create-checkout-session', async (req: Request, res: Response) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

    const orgId = (req as any).orgId;
    if (!orgId) return res.status(401).json({ error: 'Not authenticated' });

    const { plan, billingCycle, returnUrl } = req.body;

    if (!plan || !billingCycle) {
      return res.status(400).json({ error: 'Plan and billing cycle are required' });
    }

    if (plan === 'free') {
      return res.status(400).json({ error: 'Free plan does not require payment' });
    }

    if (!['agent_pro', 'business', 'enterprise'].includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    if (!['monthly', 'yearly'].includes(billingCycle)) {
      return res.status(400).json({ error: 'Invalid billing cycle' });
    }

    const planConfig = COMMUNE_PLANS[plan as CommunePlan];
    const priceId = planConfig.stripePriceIds[billingCycle as BillingCycle];

    if (!priceId) {
      return res.status(500).json({ error: `Price ID not configured for ${plan} ${billingCycle}` });
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
    const baseReturnUrl = returnUrl || `${frontendUrl}/dashboard/billing`;

    const db = await connect();
    if (!db) return res.status(500).json({ error: 'Database unavailable' });
    const org = await db.collection('organizations').findOne({ id: orgId });

    const sessionParams: any = {
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `${baseReturnUrl}?payment=success&plan=${plan}&cycle=${billingCycle}`,
      cancel_url: `${baseReturnUrl}?payment=cancelled`,
      allow_promotion_codes: true,
      metadata: { orgId, plan, billingCycle },
    };

    if (org?.stripe_customer_id) {
      sessionParams.customer = org.stripe_customer_id;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    res.json({ sessionId: session.id, url: session.url });
  } catch (error: any) {
    logger.error('Error creating checkout session', { error: error.message });
    res.status(500).json({ error: error.message || 'Failed to create checkout session' });
  }
});

router.post('/billing/create-portal-session', async (req: Request, res: Response) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

    const orgId = (req as any).orgId;
    if (!orgId) return res.status(401).json({ error: 'Not authenticated' });

    const db = await connect();
    if (!db) return res.status(500).json({ error: 'Database unavailable' });
    const org = await db.collection('organizations').findOne({ id: orgId });

    if (!org?.stripe_customer_id) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';

    const session = await stripe.billingPortal.sessions.create({
      customer: org.stripe_customer_id,
      return_url: `${frontendUrl}/dashboard/billing`,
    });

    res.json({ url: session.url });
  } catch (error: any) {
    logger.error('Error creating portal session', { error: error.message });
    res.status(500).json({ error: error.message || 'Failed to create portal session' });
  }
});

router.post('/billing/cancel-subscription', async (req: Request, res: Response) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

    const orgId = (req as any).orgId;
    if (!orgId) return res.status(401).json({ error: 'Not authenticated' });

    const db = await connect();
    if (!db) return res.status(500).json({ error: 'Database unavailable' });
    const org = await db.collection('organizations').findOne({ id: orgId });

    if (!org?.stripe_subscription_id) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    await stripe.subscriptions.cancel(org.stripe_subscription_id);

    await db.collection('organizations').updateOne(
      { id: orgId },
      {
        $set: {
          tier: 'free',
          billing_cycle: 'monthly',
          stripe_subscription_id: null,
          plan_updated_at: new Date().toISOString(),
        },
      }
    );

    res.json({ message: 'Subscription cancelled successfully' });
  } catch (error: any) {
    logger.error('Error cancelling subscription', { error: error.message });
    res.status(500).json({ error: error.message || 'Failed to cancel subscription' });
  }
});

// ─── Credit bundles ──────────────────────────────────────────────

router.get('/billing/credit-bundles', async (_req: Request, res: Response) => {
  const bundles = Object.entries(CREDIT_BUNDLES).map(([id, b]) => ({
    id,
    credits: b.credits,
    price: b.price,
    pricePerCredit: (b.price / b.credits).toFixed(4),
    available: !!b.stripePriceId,
  }));
  res.json({ data: bundles });
});

router.get('/billing/credit-balance', async (req: Request, res: Response) => {
  try {
    const orgId = (req as any).orgId;
    if (!orgId) return res.status(401).json({ error: 'Not authenticated' });
    const balance = await creditStore.getBalance(orgId);
    res.json({ data: balance });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/billing/create-credits-checkout', async (req: Request, res: Response) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

    const orgId = (req as any).orgId;
    if (!orgId) return res.status(401).json({ error: 'Not authenticated' });

    const { bundle, returnUrl } = req.body;
    if (!bundle || !CREDIT_BUNDLES[bundle]) {
      return res.status(400).json({ error: 'Invalid bundle. Choose: starter, growth, scale' });
    }

    const bundleConfig = CREDIT_BUNDLES[bundle];
    if (!bundleConfig.stripePriceId) {
      return res.status(500).json({ error: `Stripe price not configured for bundle: ${bundle}` });
    }

    const db = await connect();
    if (!db) return res.status(500).json({ error: 'Database unavailable' });
    const org = await db.collection('organizations').findOne({ id: orgId });

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
    const baseReturnUrl = returnUrl || `${frontendUrl}/dashboard/billing`;

    const sessionParams: any = {
      payment_method_types: ['card'],
      line_items: [{ price: bundleConfig.stripePriceId, quantity: 1 }],
      mode: 'payment',
      success_url: `${baseReturnUrl}?credits_purchased=true&bundle=${bundle}`,
      cancel_url: `${baseReturnUrl}?payment=cancelled`,
      allow_promotion_codes: true,
      metadata: {
        orgId,
        purchase_type: 'credits',
        credits: String(bundleConfig.credits),
        bundle,
      },
    };

    if (org?.stripe_customer_id) {
      sessionParams.customer = org.stripe_customer_id;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    logger.info('Credits checkout session created', { orgId, bundle, credits: bundleConfig.credits });
    res.json({ sessionId: session.id, url: session.url, credits: bundleConfig.credits });
  } catch (error: any) {
    logger.error('Error creating credits checkout session', { error: error.message });
    res.status(500).json({ error: error.message || 'Failed to create checkout session' });
  }
});

export default router;
