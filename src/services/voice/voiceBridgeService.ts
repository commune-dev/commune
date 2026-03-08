/**
 * voiceBridgeService.ts
 *
 * Bridges Twilio Media Streams ↔ OpenAI Realtime WebSocket.
 *
 * Protocol: GA (no OpenAI-Beta header) with FLAT session schema.
 * Audio:    g711_ulaw passthrough (Twilio audio/x-mulaw ↔ OpenAI g711_ulaw — zero conversion).
 * Nonce:    Validated in 'start' event from customParameters (Twilio strips URL query params).
 * Barge-in: speech_started → Twilio clear + conversation.item.truncate + response.cancel.
 * Tools:    response.output_item.done (function_call) → non-blocking .then() webhook dispatch.
 */

import WebSocket, { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server as HttpServer } from 'http';
import dns from 'dns';
import { createHmac } from 'crypto';
import { getCollection } from '../../db';
import * as callStore from '../../stores/callStore';
import * as voiceAgentStore from '../../stores/voiceAgentStore';
import * as toolStore from '../../stores/toolStore';
import { subaccountClient } from '../sms/twilioService';
import { decrypt } from '../../lib/encryption';
import logger from '../../utils/logger';
import type { Organization } from '../../types/auth';
import type { Tool, VoiceAgent, TranscriptEntry, ToolCallLogEntry } from '../../types/voice';

// ─── Constants ────────────────────────────────────────────────────

const OPENAI_WS_URL = `wss://api.openai.com/v1/realtime?model=${process.env.OPENAI_VOICE_MODEL || 'gpt-4o-realtime-preview'}`;

const VOICE_CREDITS_PER_MIN: Record<string, number> = {
  US_OUTBOUND: 50,
  US_INBOUND: 35,
  DEFAULT_OUTBOUND: 60,
};

// Max time to wait for Twilio 'start' event before closing stale connection
const STALE_CONNECTION_TIMEOUT_MS = 30_000;

// ─── Active call registry (for SIGTERM cleanup) ───────────────────

export const activeCalls = new Map<string, {
  twilioWs: WebSocket;
  openaiWs: WebSocket;
  callId: string;
  callSid: string;
  orgId: string;
}>();

// ─── SSRF validation (re-run at execution time — DNS rebinding defense) ──

const PRIVATE_IPV4: Array<(ip: string) => boolean> = [
  (ip) => ip === '127.0.0.1' || ip.startsWith('127.'),
  (ip) => ip.startsWith('10.'),
  (ip) => { const p = ip.split('.').map(Number); return p[0] === 172 && p[1] >= 16 && p[1] <= 31; },
  (ip) => ip.startsWith('192.168.'),
  (ip) => ip.startsWith('169.254.'),
  (ip) => ip.startsWith('0.'),
  (ip) => { const p = ip.split('.').map(Number); return p[0] === 100 && p[1] >= 64 && p[1] <= 127; },
];

const PRIVATE_IPV6: Array<(ip: string) => boolean> = [
  (ip) => ip === '::1',
  (ip) => ip.startsWith('fc') || ip.startsWith('fd'),   // fc00::/7 ULA
  (ip) => ip.startsWith('fe80'),                         // fe80::/10 link-local
  (ip) => ip.startsWith('::ffff:'),                      // IPv4-mapped
  (ip) => ip.startsWith('64:ff9b:'),                     // NAT64
];

function isPrivateIp(ip: string): boolean {
  const lc = ip.toLowerCase();
  return lc.includes(':')
    ? PRIVATE_IPV6.some((fn) => fn(lc))
    : PRIVATE_IPV4.some((fn) => fn(ip));
}

async function validateWebhookUrlRuntime(url: string): Promise<void> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('Invalid URL'); }
  if (parsed.protocol !== 'https:') throw new Error('Must be HTTPS');

  const [ipv4, ipv6] = await Promise.allSettled([
    dns.promises.resolve4(parsed.hostname),
    dns.promises.resolve6(parsed.hostname),
  ]);
  const ips = [
    ...(ipv4.status === 'fulfilled' ? ipv4.value : []),
    ...(ipv6.status === 'fulfilled' ? ipv6.value : []),
  ];
  if (ips.length === 0) throw new Error('Cannot resolve hostname');
  for (const ip of ips) {
    if (isPrivateIp(ip)) throw new Error(`Blocked IP: ${ip}`);
  }
}

// ─── Tool schema for OpenAI ───────────────────────────────────────

function toOpenAIToolSchema(tool: Tool): Record<string, unknown> {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

// ─── Webhook execution (SSRF-safe, HMAC-signed, with retry) ──────

async function executeToolWebhook(
  tool: Tool,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Re-validate SSRF at execution time (DNS rebinding defense)
  await validateWebhookUrlRuntime(tool.implementation.url);

  let plainSecret = '';
  try { plainSecret = decrypt(tool.implementation.webhookSecret); } catch { /* fall through */ }

  const timestamp = Date.now();
  const bodyStr = JSON.stringify(args);
  const hmacPayload = `${timestamp}.${bodyStr}`;
  const signature = plainSecret
    ? createHmac('sha256', plainSecret).update(hmacPayload).digest('hex')
    : '';

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Commune-Timestamp': String(timestamp),
    ...(tool.implementation.headers ?? {}),
  };
  if (signature) headers['X-Commune-Signature'] = `sha256=${signature}`;

  const maxAttempts = 1 + (tool.implementation.retries ?? 1);
  let lastError: Error = new Error('Tool execution failed');

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), tool.implementation.timeoutMs);

    try {
      const response = await fetch(tool.implementation.url, {
        method: tool.implementation.method,
        redirect: 'error',  // block redirect chains (SSRF defense)
        headers,
        body: tool.implementation.method === 'POST' ? bodyStr : undefined,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      try { return await response.json(); }
      catch { return { result: await response.text() }; }
    } catch (err) {
      clearTimeout(timeout);
      lastError = err instanceof Error ? err : new Error(String(err));
      // Don't retry on redirect errors (SSRF attempt) or SSRF validation failures
      if (lastError.message.startsWith('redirect') || lastError.message.startsWith('Blocked')) break;
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }

  throw lastError;
}

// ─── Twilio REST: hang up a call ─────────────────────────────────

async function hangUpCall(callSid: string, orgId: string): Promise<void> {
  try {
    const orgCol = await getCollection<Organization>('organizations');
    const org = await orgCol?.findOne({ id: orgId });
    if (!org?.twilioSubaccountSid || !org?.twilioSubaccountAuthToken) return;

    await subaccountClient(org.twilioSubaccountSid, org.twilioSubaccountAuthToken)
      .calls(callSid)
      .update({ status: 'completed' });
  } catch (err) {
    logger.warn('Failed to hang up call via Twilio REST', { callSid, err });
  }
}

// ─── Main connection handler (all state closure-scoped per call) ──

async function handleVoiceConnection(
  twilioWs: WebSocket,
  callId: string,
): Promise<void> {
  // ─── Per-connection state ──────────────────────────────────────
  let openaiWs: WebSocket | null = null;
  let streamSid: string | null = null;
  let latestMediaTimestamp = 0;
  let responseStartTimestamp: number | null = null;
  let currentItemId: string | null = null;
  const markQueue: Array<{ label: string; timestamp: number }> = [];
  const transcript: TranscriptEntry[] = [];
  const toolCallLog: ToolCallLogEntry[] = [];
  let sessionInitialized = false;
  let finalized = false;
  let callRecord: Awaited<ReturnType<typeof callStore.getCallByInternalId>> = null;
  let voiceAgent: VoiceAgent | null = null;
  let sessionTools: Tool[] = [];
  let maxDurationTimer: NodeJS.Timeout | null = null;
  let answeredAt: Date | null = null;
  let markSeq = 0;

  // Stale connection guard — if Twilio never sends 'start', close after 30s
  const staleTimer = setTimeout(() => {
    if (!streamSid) {
      logger.warn('Voice WS: stale connection — no start event', { callId });
      twilioWs.close(4000, 'Stale connection');
    }
  }, STALE_CONNECTION_TIMEOUT_MS);

  // ─── Finalization (idempotent) ─────────────────────────────────

  const finalize = async (status: 'completed' | 'failed') => {
    if (finalized) return;
    finalized = true;

    clearTimeout(staleTimer);
    if (maxDurationTimer) clearTimeout(maxDurationTimer);

    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }

    activeCalls.delete(callId);

    if (!callRecord) return;  // Never reached start event — nothing to settle

    const endedAt = new Date();
    const durationSeconds = answeredAt
      ? Math.round((endedAt.getTime() - answeredAt.getTime()) / 1000)
      : 0;

    // Credit settlement: charge actual usage, release unused reservation
    const isUS = callRecord.to.startsWith('+1') || callRecord.from.startsWith('+1');
    const creditsPerMin = callRecord.direction === 'inbound'
      ? VOICE_CREDITS_PER_MIN.US_INBOUND
      : (isUS ? VOICE_CREDITS_PER_MIN.US_OUTBOUND : VOICE_CREDITS_PER_MIN.DEFAULT_OUTBOUND);
    const creditsCharged = Math.ceil((durationSeconds / 60) * creditsPerMin);
    const toRelease = Math.max(0, callRecord.creditsReserved - creditsCharged);

    if (toRelease > 0) {
      callStore.releaseCredits(callRecord.orgId, toRelease).catch((err) =>
        logger.warn('Failed to release unused voice credits', { callId, err }),
      );
    }

    // Flush transcript + tool log to DB
    callStore.finalizeCall(callId, {
      status,
      endedAt,
      durationSeconds,
      transcript,
      toolCallLog,
      creditsCharged,
    }).catch((err) => logger.error('finalizeCall DB write failed', { callId, err }));

    logger.info('Voice call finalized', { callId, durationSeconds, creditsCharged, status });
  };

  // ─── Twilio WS message handler ────────────────────────────────

  twilioWs.on('message', async (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // ── connected: Twilio handshake — no-op ─────────────────────
    if (msg.event === 'connected') return;

    // ── start: call answered, media stream ready ─────────────────
    if (msg.event === 'start') {
      clearTimeout(staleTimer);
      streamSid = msg.start?.streamSid ?? null;
      answeredAt = new Date();

      // Validate nonce from Twilio customParameters (Twilio strips query params from Stream URL)
      const nonce = msg.start?.customParameters?.nonce ?? '';
      const nonceValid = await callStore.consumeWsNonce(callId, nonce);
      if (!nonceValid) {
        logger.warn('Voice WS: invalid or used nonce in start event', { callId });
        twilioWs.close(4401, 'Invalid nonce');
        return;
      }

      // Load call record
      callRecord = await callStore.getCallByInternalId(callId);
      if (!callRecord) {
        logger.error('Voice WS: call record not found', { callId });
        twilioWs.close(4404, 'Call not found');
        return;
      }

      // Load voice agent config
      voiceAgent = await voiceAgentStore.getVoiceAgentById(callRecord.orgId, callRecord.voiceAgentId);
      if (!voiceAgent) {
        logger.error('Voice WS: voice agent not found', { callId, voiceAgentId: callRecord.voiceAgentId });
        twilioWs.close(4500, 'Voice agent not found');
        return;
      }

      // Load tools for this session
      if (voiceAgent.toolIds.length > 0) {
        sessionTools = await toolStore.getToolsByIds(callRecord.orgId, voiceAgent.toolIds);
      }

      // Update DB: mark call as in-progress with streamSid + answeredAt
      callStore.updateCallStatus(callRecord.callSid, 'in-progress', {
        answeredAt,
        streamSid: streamSid ?? undefined,
      }).catch((err) => logger.warn('updateCallStatus in-progress failed', { callId, err }));

      // ── Open OpenAI Realtime WS ─────────────────────────────────
      logger.info('Opening OpenAI Realtime WS', { callId });

      openaiWs = new WebSocket(OPENAI_WS_URL, {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          // NO OpenAI-Beta header — GA protocol (flat session schema)
        },
      });

      // Register in active call registry (includes callSid for SIGTERM cleanup)
      activeCalls.set(callId, { twilioWs, openaiWs, callId, callSid: callRecord.callSid, orgId: callRecord.orgId });

      // ── OpenAI WS error ──────────────────────────────────────────
      openaiWs.on('error', (err) => {
        logger.error('OpenAI Realtime WS error', { callId, err: err.message });
      });

      // ── OpenAI WS close ──────────────────────────────────────────
      openaiWs.on('close', (code) => {
        logger.info('OpenAI WS closed', { callId, code });
        if (!finalized) {
          finalize('failed');
          if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
        }
      });

      // ── OpenAI WS messages ───────────────────────────────────────
      openaiWs.on('message', (rawData) => {
        let event: any;
        try { event = JSON.parse(rawData.toString()); } catch { return; }

        // session.created → send session.update (wait for this, not 'open')
        if (event.type === 'session.created') {
          const td = voiceAgent!.turnDetection;

          // Flat schema for WebSocket wire protocol (GA — no OpenAI-Beta header)
          const sessionUpdate = {
            type: 'session.update',
            session: {
              modalities: ['audio'],
              instructions: voiceAgent!.systemPrompt,
              voice: voiceAgent!.voice ?? 'verse',
              input_audio_format: 'g711_ulaw',    // Twilio audio/x-mulaw — zero conversion
              output_audio_format: 'g711_ulaw',   // verbatim passthrough back to Twilio
              input_audio_transcription: { model: 'gpt-4o-mini-transcribe' },
              turn_detection: {
                type: 'server_vad',
                threshold: td.threshold ?? 0.5,
                prefix_padding_ms: td.prefixPaddingMs ?? 300,
                silence_duration_ms: td.silenceDurationMs ?? 500,
                ...(td.idleTimeoutMs !== undefined ? { idle_timeout_ms: td.idleTimeoutMs } : {}),
                create_response: td.createResponse ?? true,
                interrupt_response: td.interruptResponse ?? true,
              },
              tools: sessionTools.map(toOpenAIToolSchema),
              tool_choice: sessionTools.length > 0 ? 'auto' : 'none',
              max_response_output_tokens: 1024,
            },
          };

          openaiWs!.send(JSON.stringify(sessionUpdate));
          return;
        }

        // session.updated → session ready, start the call
        if (event.type === 'session.updated' && !sessionInitialized) {
          sessionInitialized = true;

          // Start max duration enforcement timer
          const maxMs = (voiceAgent!.maxCallDurationSeconds ?? 600) * 1000;
          maxDurationTimer = setTimeout(() => {
            logger.info('Voice call max duration reached — hanging up', { callId });
            if (callRecord) {
              hangUpCall(callRecord.callSid, callRecord.orgId);
            }
          }, maxMs);

          // Send firstMessage for outbound call greeting
          if (voiceAgent!.firstMessage) {
            openaiWs!.send(JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'text', text: voiceAgent!.firstMessage }],
              },
            }));
            openaiWs!.send(JSON.stringify({ type: 'response.create' }));
          }

          return;
        }

        // Audio: OpenAI → Twilio (handle both GA and beta event names)
        if (event.type === 'response.audio.delta' || event.type === 'response.output_audio.delta') {
          if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
            twilioWs.send(JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload: event.delta },  // verbatim base64 g711_ulaw → Twilio
            }));

            // Track start timestamp for barge-in truncation
            if (responseStartTimestamp === null) {
              responseStartTimestamp = latestMediaTimestamp;
            }

            // Mark for playback tracking (pop on Twilio echo)
            const markLabel = `ai-${++markSeq}`;
            twilioWs.send(JSON.stringify({
              event: 'mark',
              streamSid,
              mark: { name: markLabel },
            }));
            markQueue.push({ label: markLabel, timestamp: latestMediaTimestamp });
          }
          return;
        }

        // Track current AI response item (for barge-in truncation)
        if (event.type === 'response.output_item.added' && event.item?.type === 'message') {
          currentItemId = event.item.id;
        }

        // AI response complete — reset barge-in tracking state
        if (event.type === 'response.done') {
          responseStartTimestamp = null;
          currentItemId = null;
          markQueue.length = 0;
        }

        // Barge-in: caller starts speaking while AI is talking
        if (event.type === 'input_audio_buffer.speech_started') {
          if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
            // 1. Stop Twilio from playing remaining buffered AI audio
            twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));

            // 2. Truncate AI response at the point it was interrupted
            //    audio_end_ms = how far into the AI response the caller interrupted
            if (currentItemId && responseStartTimestamp !== null) {
              const elapsedMs = Math.max(0, latestMediaTimestamp - responseStartTimestamp);
              openaiWs!.send(JSON.stringify({
                type: 'conversation.item.truncate',
                item_id: currentItemId,
                content_index: 0,
                audio_end_ms: elapsedMs,
              }));
            }

            // 3. Cancel the ongoing response generation
            openaiWs!.send(JSON.stringify({ type: 'response.cancel' }));
            // NOTE: Do NOT send input_audio_buffer.clear here — when interrupt_response: true
            // the server handles buffer management. Clearing it drops the caller's new speech.

            // 4. Reset barge-in tracking state
            markQueue.length = 0;
            responseStartTimestamp = null;
            currentItemId = null;
          }
          return;
        }

        // Tool execution: response.output_item.done with function_call type
        // Use this event (not response.function_call_arguments.done) because it has name + call_id + arguments
        if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
          const { name, call_id: toolCallId, arguments: argsStr } = event.item;
          const tool = sessionTools.find((t) => t.name === name);

          if (!tool) {
            logger.warn('Voice bridge: unknown tool called', { callId, toolName: name });
            openaiWs!.send(JSON.stringify({
              type: 'conversation.item.create',
              item: { type: 'function_call_output', call_id: toolCallId, output: JSON.stringify({ error: 'unknown_tool' }) },
            }));
            openaiWs!.send(JSON.stringify({ type: 'response.create' }));
            return;
          }

          let args: Record<string, unknown>;
          try {
            args = JSON.parse(argsStr ?? '{}');
          } catch {
            openaiWs!.send(JSON.stringify({
              type: 'conversation.item.create',
              item: { type: 'function_call_output', call_id: toolCallId, output: JSON.stringify({ error: 'invalid_arguments' }) },
            }));
            openaiWs!.send(JSON.stringify({ type: 'response.create' }));
            return;
          }

          const startMs = Date.now();

          // NON-BLOCKING — never await in WS message handler
          // Awaiting here would block ALL subsequent OpenAI events (audio, VAD) for tool duration
          executeToolWebhook(tool, args)
            .then((result) => {
              if (openaiWs?.readyState === WebSocket.OPEN) {
                openaiWs.send(JSON.stringify({
                  type: 'conversation.item.create',
                  item: { type: 'function_call_output', call_id: toolCallId, output: JSON.stringify(result) },
                }));
                openaiWs.send(JSON.stringify({ type: 'response.create' }));  // MANDATORY
              }

              toolCallLog.push({
                toolId: tool.id,
                toolName: tool.name,
                toolVersion: tool.version,
                callId: toolCallId,
                arguments: args,
                result: JSON.stringify(result),
                durationMs: Date.now() - startMs,
                success: true,
                timestamp: new Date(),
              });
            })
            .catch((err: Error) => {
              if (openaiWs?.readyState === WebSocket.OPEN) {
                openaiWs.send(JSON.stringify({
                  type: 'conversation.item.create',
                  item: { type: 'function_call_output', call_id: toolCallId, output: JSON.stringify({ error: err.message }) },
                }));
                openaiWs.send(JSON.stringify({ type: 'response.create' }));
              }

              toolCallLog.push({
                toolId: tool.id,
                toolName: tool.name,
                toolVersion: tool.version,
                callId: toolCallId,
                arguments: args,
                durationMs: Date.now() - startMs,
                success: false,
                error: err.message,
                timestamp: new Date(),
              });

              logger.warn('Tool webhook failed', { callId, toolName: name, err: err.message });
            });

          return;
        }

        // Transcript: AI speech completed
        if (event.type === 'response.audio_transcript.done' && event.transcript) {
          transcript.push({
            role: 'assistant',
            content: event.transcript,
            timestamp: new Date(),
            itemId: event.item_id ?? '',
          });
          return;
        }

        // Transcript: User speech transcription completed
        if (event.type === 'conversation.item.input_audio_transcription.completed' && event.transcript) {
          transcript.push({
            role: 'user',
            content: event.transcript,
            timestamp: new Date(),
            itemId: event.item_id ?? '',
          });
          return;
        }

        // Error handling
        if (event.type === 'error') {
          const { type: errorType, code: errorCode, message: errorMessage } = event.error ?? {};
          logger.error('OpenAI Realtime API error', { callId, errorType, errorCode, errorMessage });

          // Fatal errors — close the call
          if (
            errorType === 'rate_limits_exceeded' ||
            errorCode === 'session_not_found' ||
            errorCode === 'model_not_found'
          ) {
            finalize('failed');
            if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
            openaiWs?.close();
          }
          // Non-fatal errors (bad tool schema, etc.) — log and continue
          return;
        }
      });

      return;  // end of 'start' handler
    }

    // ── media: Twilio → OpenAI (verbatim g711_ulaw passthrough) ─────
    if (msg.event === 'media') {
      latestMediaTimestamp = parseInt(msg.media?.timestamp ?? '0', 10);
      if (openaiWs?.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: msg.media.payload,  // same base64 mu-law — zero conversion
        }));
      }
      return;
    }

    // ── mark: Twilio echoes back confirming audio was played ─────────
    if (msg.event === 'mark') {
      markQueue.shift();  // pop oldest pending mark — audio was delivered to caller
      return;
    }

    // ── stop: Twilio ending the stream ───────────────────────────────
    if (msg.event === 'stop') {
      finalize('completed');
      return;
    }
  });

  // ─── Twilio WS lifecycle handlers ─────────────────────────────────

  twilioWs.on('close', () => {
    // Call finalize in case 'stop' event was missed (e.g. abrupt hangup)
    finalize('completed');
    openaiWs?.close();
  });

  twilioWs.on('error', (err) => {
    logger.warn('Twilio WS error', { callId, err: err.message });
    finalize('failed');
    openaiWs?.close();
  });
}

// ─── Attach voice WS server to HTTP server ────────────────────────

/**
 * Registers a WebSocket upgrade handler for /ws/voice/:callId paths.
 * Must be called BEFORE realtimeService.attachToServer() in server.ts.
 */
export function attachVoiceWS(httpServer: HttpServer): void {
  const voiceWss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req: IncomingMessage, socket: any, head: Buffer) => {
    const url = new URL(req.url || '', 'http://localhost');
    const match = url.pathname.match(/^\/ws\/voice\/([a-zA-Z0-9_]+)$/);

    // Not our path — let other handlers take it (don't destroy!)
    if (!match) return;

    const callId = match[1];

    // Accept the WS upgrade — nonce is validated in the 'start' event because
    // Twilio strips all query params from Stream URLs so they never reach here.
    // The nonce arrives via msg.start.customParameters.nonce (from <Parameter> tag in TwiML).
    voiceWss.handleUpgrade(req, socket, head, (ws) => {
      voiceWss.emit('connection', ws, req, callId);
    });
  });

  voiceWss.on('connection', (ws: WebSocket, _req: IncomingMessage, callId: string) => {
    handleVoiceConnection(ws, callId).catch((err) => {
      logger.error('handleVoiceConnection unhandled error', { callId, err: err.message });
      ws.close();
    });
  });

  logger.info('Voice WS bridge attached');
}
