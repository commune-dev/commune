import { Router } from 'express';
import { z } from 'zod';
import { creditStore } from '../../stores/creditStore';
import { CREDIT_BUNDLES } from '../../config/smsCosts';
import logger from '../../utils/logger';

const router = Router();

// ─── GET /credits ─────────────────────────────────────────────────

router.get('/', async (req: any, res) => {
  try {
    const balance = await creditStore.getBalance(req.orgId);
    return res.json({ data: balance });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /credits/checkout ───────────────────────────────────────

const CheckoutSchema = z.object({
  bundle: z.enum(['starter', 'growth', 'scale']),
  success_url: z.string().url().optional(),
  cancel_url: z.string().url().optional(),
});

router.post('/checkout', async (req: any, res) => {
  const parsed = CheckoutSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }

  const { bundle, success_url, cancel_url } = parsed.data;
  const bundleConfig = CREDIT_BUNDLES[bundle];

  if (!bundleConfig.stripePriceId) {
    return res.status(503).json({
      error: 'credit_bundles_not_configured',
      message: 'Credit purchase is not yet configured. Contact support.',
    });
  }

  try {
    const stripe = (await import('stripe')).default;
    const stripeClient = new stripe(process.env.STRIPE_SECRET_KEY ?? '', { apiVersion: '2026-01-28.clover' });

    const frontendUrl = process.env.FRONTEND_URL ?? 'https://app.commune.email';
    const session = await stripeClient.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: bundleConfig.stripePriceId, quantity: 1 }],
      success_url: success_url ?? `${frontendUrl}/dashboard/billing?credits=purchased`,
      cancel_url: cancel_url ?? `${frontendUrl}/dashboard/billing`,
      metadata: {
        orgId: req.orgId,
        purchase_type: 'credits',
        bundle,
        credits: String(bundleConfig.credits),
      },
    });

    return res.json({ data: { checkout_url: session.url, bundle, credits: bundleConfig.credits, price: bundleConfig.price } });
  } catch (err: any) {
    logger.error('Failed to create credits checkout session', { error: err, orgId: req.orgId });
    return res.status(500).json({ error: 'Failed to create checkout session', details: err.message });
  }
});

// ─── GET /credits/bundles ─────────────────────────────────────────

router.get('/bundles', async (_req, res) => {
  const bundles = Object.entries(CREDIT_BUNDLES).map(([key, b]) => ({
    id: key,
    credits: b.credits,
    price: b.price,
    price_per_credit: (b.price / b.credits).toFixed(4),
  }));
  return res.json({ data: bundles });
});

export default router;
