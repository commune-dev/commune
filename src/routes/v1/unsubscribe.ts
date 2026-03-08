import { Router, json } from 'express';
import { verifyUnsubscribeToken } from '../../lib/unsubscribeToken';
import suppressionStore from '../../stores/suppressionStore';
import logger from '../../utils/logger';

const router = Router();

// Prevent XSS — escape all user-controlled values before HTML interpolation
const escapeHtml = (str: string): string =>
  str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * POST /unsubscribe
 * RFC 8058: One-click unsubscribe.
 * This is what Gmail/Yahoo call when user clicks "Unsubscribe" in their UI.
 * No authentication required — the HMAC token IS the auth.
 */
router.post('/', json(), async (req, res) => {
  const token = (req.query.token as string) || req.body?.token;

  if (!token) {
    return res.status(400).json({ error: 'Missing unsubscribe token' });
  }

  const payload = verifyUnsubscribeToken(token);
  if (!payload) {
    return res.status(400).json({ error: 'Invalid or tampered unsubscribe token' });
  }

  // Add to suppression list — idempotent (upsert)
  await suppressionStore.addSuppression({
    email: payload.recipient,
    reason: 'unsubscribe',
    type: 'permanent',
    source: payload.inboxId ? 'inbox' : 'global',
    inbox_id: payload.inboxId,
    metadata: {
      unsubscribed_via: 'one-click',
      org_id: payload.orgId,
    },
  });

  logger.info('One-click unsubscribe', { recipient: payload.recipient, orgId: payload.orgId });

  // RFC 8058 requires 200 response
  return res.status(200).json({ success: true, message: 'Successfully unsubscribed' });
});

/**
 * GET /unsubscribe
 * Browser-accessible unsubscribe page.
 * For email clients that open the URL in a browser instead of doing POST.
 */
router.get('/', async (req, res) => {
  const token = req.query.token as string;

  if (!token) {
    return res.status(400).send(renderUnsubscribePage({ error: 'Missing token' }));
  }

  const payload = verifyUnsubscribeToken(token);
  if (!payload) {
    return res.status(400).send(renderUnsubscribePage({ error: 'Invalid or expired token' }));
  }

  // Check if already unsubscribed
  const alreadySuppressed = await suppressionStore.isSuppressed(
    payload.recipient,
    payload.inboxId
  );

  if (alreadySuppressed) {
    return res.send(renderUnsubscribePage({
      success: true,
      message: 'You are already unsubscribed.',
      email: payload.recipient,
    }));
  }

  // Show confirmation page with form that POSTs back
  return res.send(renderUnsubscribePage({
    confirm: true,
    email: payload.recipient,
    token,
  }));
});

const renderUnsubscribePage = (opts: {
  error?: string;
  success?: boolean;
  message?: string;
  confirm?: boolean;
  email?: string;
  token?: string;
}): string => {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribe</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  max-width:480px;margin:80px auto;padding:24px;text-align:center;color:#1a1a1a;
  background:#fafafa;line-height:1.6}
h1{font-size:28px;font-weight:700;margin-bottom:12px}
p{color:#555;margin-bottom:16px;font-size:15px}
.card{background:#fff;border-radius:12px;padding:40px 32px;box-shadow:0 1px 3px rgba(0,0,0,0.1)}
button{background:#111;color:#fff;border:none;padding:14px 40px;border-radius:8px;
  font-size:16px;font-weight:600;cursor:pointer;transition:background 0.2s}
button:hover{background:#333}
.error{color:#dc2626}
.success{color:#16a34a}
.muted{font-size:13px;color:#999;margin-top:24px}
</style>
</head>
<body>
<div class="card">
${opts.error ? `<h1 class="error">Error</h1><p>${escapeHtml(opts.error)}</p>` : ''}
${opts.success ? `<h1 class="success">Unsubscribed</h1><p>${escapeHtml(opts.message || `${opts.email || ''} has been unsubscribed.`)}</p>` : ''}
${opts.confirm ? `<h1>Unsubscribe</h1>
<p>Unsubscribe <strong>${escapeHtml(opts.email || '')}</strong> from future emails?</p>
<form method="POST" action="/unsubscribe?token=${encodeURIComponent(opts.token || '')}">
<button type="submit">Unsubscribe</button>
</form>
<p class="muted">You can re-subscribe at any time by contacting the sender.</p>` : ''}
</div>
</body>
</html>`;
};

export default router;
