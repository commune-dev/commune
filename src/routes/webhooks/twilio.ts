import { Router } from 'express';
import { handleInboundSms, handleStatusCallback } from '../../services/sms/smsService';
import * as callStore from '../../stores/callStore';
import logger from '../../utils/logger';
import type { TwilioVoiceStatusPayload } from '../../types/voice';

const router = Router();

/**
 * POST /api/webhooks/twilio/inbound
 * Twilio calls this for every inbound SMS/MMS.
 * Body is application/x-www-form-urlencoded (handled by urlencoded middleware in server.ts).
 * Must return TwiML XML with Content-Type: text/xml.
 */
router.post('/inbound', async (req, res) => {
  try {
    const result = await handleInboundSms(req);

    res.setHeader('Content-Type', 'text/xml');
    return res.send(result.twiml);
  } catch (err: any) {
    if (err.code === 'invalid_signature') {
      logger.warn('Twilio inbound webhook rejected: invalid signature');
      return res.status(403).json({ error: 'Invalid signature' });
    }
    logger.error('Twilio inbound webhook error', { error: err });
    // Return empty TwiML on error so Twilio doesn't retry endlessly
    res.setHeader('Content-Type', 'text/xml');
    return res.send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
  }
});

/**
 * POST /api/webhooks/twilio/status
 * Twilio calls this for delivery status updates (queued → sending → sent → delivered/failed).
 * Body is application/x-www-form-urlencoded.
 */
router.post('/status', async (req, res) => {
  try {
    await handleStatusCallback(req);
    return res.json({ ok: true });
  } catch (err: any) {
    if (err.code === 'invalid_signature') {
      logger.warn('Twilio status webhook rejected: invalid signature');
      return res.status(403).json({ error: 'Invalid signature' });
    }
    logger.error('Twilio status webhook error', { error: err });
    return res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /api/webhooks/twilio/voice/status
 * Twilio calls this for voice call lifecycle events:
 * initiated → ringing → in-progress (answered) → completed|busy|no-answer|failed|canceled
 *
 * Body is application/x-www-form-urlencoded (handled by urlencoded middleware in server.ts).
 * These callbacks supplement the WebSocket bridge — the bridge does the heavy lifting;
 * this ensures DB status is correct even if the bridge misses a state transition.
 */
router.post('/voice/status', async (req, res) => {
  try {
    const body = req.body as TwilioVoiceStatusPayload;
    const { CallSid, CallStatus, CallDuration } = body;

    if (!CallSid || !CallStatus) {
      return res.status(400).json({ error: 'Missing CallSid or CallStatus' });
    }

    // Map Twilio call status to our internal status
    const statusMap: Record<string, string> = {
      initiated:    'ringing',
      ringing:      'ringing',
      'in-progress': 'in-progress',
      completed:    'completed',
      busy:         'busy',
      'no-answer':  'no-answer',
      failed:       'failed',
      canceled:     'failed',
    };

    const internalStatus = statusMap[CallStatus];
    if (!internalStatus) {
      return res.status(200).json({ ok: true });  // unknown status — ignore
    }

    const extra: Record<string, unknown> = {};
    if (CallStatus === 'in-progress') {
      extra.startedAt = new Date();
    }
    if (['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(CallStatus)) {
      extra.endedAt = new Date();
      if (CallDuration) {
        extra.durationSeconds = parseInt(CallDuration, 10);
      }
    }

    await callStore.updateCallStatus(CallSid, internalStatus as any, extra as any);

    logger.info('Twilio voice status callback', { callSid: CallSid, status: CallStatus });
    return res.status(200).json({ ok: true });
  } catch (err) {
    logger.error('Twilio voice status webhook error', { err });
    return res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /api/webhooks/twilio/voice/amd/:callId
 * Async Answering Machine Detection callback.
 * Fired when machineDetection is enabled on an outbound call.
 * AnsweredBy: 'human' | 'machine_start' | 'machine_end_beep' | ...
 */
router.post('/voice/amd/:callId', async (req, res) => {
  try {
    const { callId } = req.params;
    const { AnsweredBy, CallSid } = req.body;

    logger.info('Twilio AMD callback', { callId, callSid: CallSid, answeredBy: AnsweredBy });

    // For machine detection, could auto-hangup if AnsweredBy !== 'human'
    // Currently just logs — caller's POST /v1/calls can specify machineDetection to opt-in
    return res.status(200).json({ ok: true });
  } catch (err) {
    logger.error('Twilio AMD webhook error', { err });
    return res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
