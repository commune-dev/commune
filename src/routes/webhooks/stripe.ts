import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { getStripe, getPlanFromPriceId, getBillingCycleFromInterval } from '../../lib/stripe';
import { connect } from '../../db';
import { invalidateTierCache } from '../../lib/tierResolver';
import { creditStore } from '../../stores/creditStore';
import { PLAN_PHONE_CREDITS } from '../../config/smsCosts';
import logger from '../../utils/logger';

const router = Router();

router.post('/stripe', async (req: Request, res: Response) => {
  const stripe = getStripe();
  if (!stripe) {
    logger.warn('Stripe webhook received but Stripe not configured');
    return res.status(200).json({ received: true });
  }

  const sig = req.headers['stripe-signature'] as string;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    logger.warn('Stripe webhook secret not configured');
    return res.status(200).json({ received: true });
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err: any) {
    logger.error('Stripe webhook signature verification failed', { error: err.message });
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  logger.info('Stripe webhook received', { type: event.type, id: event.id });

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleCheckoutCompleted(stripe, session);
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionUpdated(stripe, subscription);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionDeleted(subscription);
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice;
        await handleInvoicePaid(stripe, invoice);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        await handleInvoicePaymentFailed(invoice);
        break;
      }

      default:
        logger.debug('Unhandled Stripe webhook event', { type: event.type });
    }
  } catch (error: any) {
    logger.error('Stripe webhook processing error', { type: event.type, error: error.message });
  }

  res.status(200).json({ received: true });
});

async function handleCheckoutCompleted(stripe: Stripe, session: Stripe.Checkout.Session) {
  const orgId = session.metadata?.orgId;
  const purchaseType = session.metadata?.purchase_type;

  if (!orgId) {
    logger.warn('Checkout session missing orgId', { sessionId: session.id });
    return;
  }

  // ── Credit bundle purchase ──────────────────────────────────────
  if (purchaseType === 'credits') {
    const credits = parseInt(session.metadata?.credits ?? '0', 10);
    if (credits > 0) {
      await creditStore.addPurchasedCredits(orgId, credits, session.payment_intent as string ?? session.id);
      logger.info('Credits added via checkout', { orgId, credits, sessionId: session.id });
    }
    return;
  }

  // ── Subscription upgrade ────────────────────────────────────────
  const plan = session.metadata?.plan;
  const billingCycle = session.metadata?.billingCycle;

  if (!plan) {
    logger.warn('Checkout session missing plan metadata', { sessionId: session.id });
    return;
  }

  const db = await connect();
  if (!db) {
    logger.error('Database unavailable during checkout webhook');
    return;
  }

  const customerId = typeof session.customer === 'string'
    ? session.customer
    : (session.customer as any)?.id;

  const subscriptionId = typeof session.subscription === 'string'
    ? session.subscription
    : (session.subscription as any)?.id;

  await db.collection('organizations').updateOne(
    { id: orgId },
    {
      $set: {
        tier: plan,
        billing_cycle: billingCycle || 'monthly',
        stripe_customer_id: customerId || null,
        stripe_subscription_id: subscriptionId || null,
        plan_updated_at: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    }
  );

  // Seed initial credits for the new plan
  const planCredits = PLAN_PHONE_CREDITS[plan];
  if (planCredits && isFinite(planCredits)) {
    const cycleResetAt = new Date();
    cycleResetAt.setMonth(cycleResetAt.getMonth() + 1);
    await creditStore.resetIncludedCredits(orgId, planCredits, cycleResetAt);
    logger.info('Initial credits seeded on plan upgrade', { orgId, plan, credits: planCredits });
  }

  invalidateTierCache(orgId);

  logger.info('Organization upgraded via checkout', { orgId, plan, billingCycle, customerId, subscriptionId });
}

async function handleInvoicePaid(stripe: Stripe, invoice: Stripe.Invoice) {
  const customerId = typeof invoice.customer === 'string'
    ? invoice.customer
    : (invoice.customer as any)?.id;

  if (!customerId) return;

  const db = await connect();
  if (!db) return;

  const org = await db.collection('organizations').findOne({ stripe_customer_id: customerId });
  if (!org) {
    logger.warn('No org found for Stripe customer on invoice.paid', { customerId });
    return;
  }

  // Determine plan from subscription
  const invoiceAny = invoice as any;
  const subscriptionId = typeof invoiceAny.subscription === 'string'
    ? invoiceAny.subscription
    : invoiceAny.subscription?.id;

  if (!subscriptionId) return; // One-time payment, not a subscription renewal

  const subscription = await stripe.subscriptions.retrieve(subscriptionId) as any;
  const priceId = subscription.items?.data[0]?.price?.id;
  const plan = priceId ? getPlanFromPriceId(priceId) : org.tier;

  if (!plan) return;

  const planCredits = PLAN_PHONE_CREDITS[plan];
  if (!planCredits || !isFinite(planCredits)) return;

  // Reset included credits for new billing cycle
  const periodEnd = subscription.current_period_end;
  const cycleResetAt = periodEnd ? new Date(periodEnd * 1000) : (() => {
    const d = new Date(); d.setMonth(d.getMonth() + 1); return d;
  })();

  await creditStore.resetIncludedCredits(org.id, planCredits, cycleResetAt);

  // Charge for active phone numbers (monthly rental)
  await creditStore.chargeForActivePhoneNumbers(org.id);

  logger.info('Invoice paid: credits reset', {
    orgId: org.id,
    plan,
    credits: planCredits,
    cycleResetAt,
  });
}

async function handleSubscriptionUpdated(stripe: Stripe, subscription: Stripe.Subscription) {
  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : (subscription.customer as any)?.id;

  if (!customerId) return;

  const db = await connect();
  if (!db) return;

  const org = await db.collection('organizations').findOne({ stripe_customer_id: customerId });
  if (!org) {
    logger.warn('No org found for Stripe customer', { customerId });
    return;
  }

  const priceId = subscription.items.data[0]?.price?.id;
  if (!priceId) return;

  const newPlan = getPlanFromPriceId(priceId);
  const interval = subscription.items.data[0]?.price?.recurring?.interval;
  const newCycle = getBillingCycleFromInterval(interval);

  if (newPlan && newPlan !== org.tier) {
    await db.collection('organizations').updateOne(
      { id: org.id },
      {
        $set: {
          tier: newPlan,
          billing_cycle: newCycle,
          stripe_subscription_id: subscription.id,
          plan_updated_at: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }
    );

    // Invalidate cached tier so rate limiters pick up new limits immediately
    invalidateTierCache(org.id);

    logger.info('Subscription updated', {
      orgId: org.id,
      oldTier: org.tier,
      newTier: newPlan,
      cycle: newCycle,
    });
  }
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : (subscription.customer as any)?.id;

  if (!customerId) return;

  const db = await connect();
  if (!db) return;

  const result = await db.collection('organizations').updateOne(
    { stripe_customer_id: customerId },
    {
      $set: {
        tier: 'free',
        billing_cycle: 'monthly',
        stripe_subscription_id: null,
        plan_updated_at: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    }
  );

  if (result.modifiedCount > 0) {
    // Find the org to invalidate its tier cache
    const org = await db.collection('organizations').findOne({ stripe_customer_id: customerId });
    if (org) invalidateTierCache(org.id);

    logger.info('Subscription deleted, org downgraded to free', { customerId });
  }
}

async function handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
  const customerId = typeof invoice.customer === 'string'
    ? invoice.customer
    : (invoice.customer as any)?.id;

  if (!customerId) return;

  const db = await connect();
  if (!db) return;

  const org = await db.collection('organizations').findOne({ stripe_customer_id: customerId });
  if (!org) {
    logger.warn('No org found for Stripe customer on invoice.payment_failed', { customerId });
    return;
  }

  // Suspend all active phone numbers due to non-payment
  const result = await db.collection('phone_numbers').updateMany(
    { orgId: org.id, status: 'active' },
    { $set: { status: 'suspended_non_payment', updatedAt: new Date().toISOString() } }
  );

  logger.warn('Invoice payment failed — phone numbers suspended', {
    orgId: org.id,
    customerId,
    invoiceId: invoice.id,
    amountDue: invoice.amount_due,
    suspendedCount: result.modifiedCount,
  });
}

export default router;
