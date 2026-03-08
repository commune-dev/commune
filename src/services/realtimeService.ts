import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage, Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import { getCollection } from '../db';
import type { User } from '../types';
import logger from '../utils/logger';
import { getRedisClient, getSubClient } from '../lib/redis';

const JWT_SECRET = process.env.JWT_SECRET || '';
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:3001').split(',').map(s => s.trim());
const HEARTBEAT_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;

// ─── Security limits ─────────────────────────────────────────
const MAX_PAYLOAD_BYTES = 16_384;          // 16 KB max inbound frame
const MAX_CONNECTIONS_PER_ORG = 20;
const MAX_CONNECTIONS_PER_USER = 5;
const MAX_CLIENT_MESSAGES_BEFORE_KICK = 10; // silent frames before disconnect
const REVALIDATION_INTERVAL_MS = 5 * 60_000; // re-check JWT/user status every 5 min
const IP_RATE_WINDOW_MS = 60_000;           // 1 minute window
const IP_RATE_MAX_CONNECTIONS = 10;         // max 10 WS connections per IP per minute

// ─── Types ───────────────────────────────────────────────────
const ALLOWED_EVENT_TYPES = new Set(['email.received', 'email.sent', 'connection.ack', 'sms.received', 'sms.sent', 'sms.status_updated']);
const ALLOWED_DIRECTIONS = new Set(['inbound', 'outbound']);
const MAX_FIELD_LENGTH = 256;

export interface RealtimeEvent {
  type: 'email.received' | 'email.sent' | 'connection.ack' | 'sms.received' | 'sms.sent' | 'sms.status_updated';
  inbox_id?: string;
  inbox_address?: string;
  thread_id?: string;
  message_id?: string;
  subject?: string;
  from?: string;
  direction?: 'inbound' | 'outbound';
  created_at?: string;
  // SMS-specific fields
  phone_number_id?: string;
  from_number?: string;
  to_number?: string;
}

interface AuthenticatedSocket extends WebSocket {
  orgId: string;
  userId: string;
  isAlive: boolean;
  clientMessageCount: number;
  tokenExp?: number; // JWT expiry timestamp (seconds)
}

// ─── Org-scoped rooms ────────────────────────────────────────
const rooms = new Map<string, Set<AuthenticatedSocket>>();

// ─── Per-user connection tracking ────────────────────────────
const userConnectionCounts = new Map<string, number>();

// ─── Per-IP connection rate limiting ─────────────────────────
const ipConnectionLog = new Map<string, number[]>();

function isIpRateLimited(ip: string): boolean {
  const now = Date.now();
  const timestamps = (ipConnectionLog.get(ip) || []).filter(t => now - t < IP_RATE_WINDOW_MS);
  timestamps.push(now);
  ipConnectionLog.set(ip, timestamps);
  return timestamps.length > IP_RATE_MAX_CONNECTIONS;
}

// Periodic cleanup of IP rate limit entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of ipConnectionLog.entries()) {
    const active = timestamps.filter(t => now - t < IP_RATE_WINDOW_MS);
    if (active.length === 0) ipConnectionLog.delete(ip);
    else ipConnectionLog.set(ip, active);
  }
}, 60_000);

function getRoom(orgId: string): Set<AuthenticatedSocket> {
  let room = rooms.get(orgId);
  if (!room) {
    room = new Set();
    rooms.set(orgId, room);
  }
  return room;
}

function getOrgConnectionCount(orgId: string): number {
  return rooms.get(orgId)?.size || 0;
}

function getUserConnectionCount(userId: string): number {
  return userConnectionCounts.get(userId) || 0;
}

function trackUserConnect(userId: string): void {
  userConnectionCounts.set(userId, (userConnectionCounts.get(userId) || 0) + 1);
}

function trackUserDisconnect(userId: string): void {
  const count = (userConnectionCounts.get(userId) || 1) - 1;
  if (count <= 0) userConnectionCounts.delete(userId);
  else userConnectionCounts.set(userId, count);
}

function removeFromRoom(ws: AuthenticatedSocket) {
  const room = rooms.get(ws.orgId);
  if (room) {
    room.delete(ws);
    if (room.size === 0) {
      rooms.delete(ws.orgId);
    }
  }
  trackUserDisconnect(ws.userId);
}

// ─── JWT verification for WS upgrade ────────────────────────
async function authenticateUpgrade(
  req: IncomingMessage
): Promise<{ userId: string; orgId: string; tokenExp?: number } | null> {
  try {
    const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const token = url.searchParams.get('token');
    if (!token) return null;

    // Reject obviously oversized tokens (JWTs should never be >8KB)
    if (token.length > 8192) {
      logger.warn('WebSocket auth rejected: oversized token', { length: token.length });
      return null;
    }

    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (!decoded?.userId) return null;

    const userCollection = await getCollection<User>('users');
    if (!userCollection) return null;

    const user = await userCollection.findOne({
      id: decoded.userId,
      status: 'active',
      emailVerified: true,
    });

    if (!user || !user.orgId) return null;

    return { userId: user.id, orgId: user.orgId, tokenExp: decoded.exp };
  } catch (err) {
    logger.warn('WebSocket auth failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// ─── Periodic revalidation of connected sessions ────────────
async function revalidateSession(ws: AuthenticatedSocket): Promise<boolean> {
  try {
    // Check JWT expiry
    if (ws.tokenExp && Date.now() / 1000 > ws.tokenExp) {
      logger.info('WebSocket session expired (JWT)', { userId: ws.userId, orgId: ws.orgId });
      return false;
    }

    // Check user is still active in DB
    const userCollection = await getCollection<User>('users');
    if (!userCollection) return true; // fail open if DB unavailable

    const user = await userCollection.findOne({
      id: ws.userId,
      status: 'active',
    });

    if (!user) {
      logger.info('WebSocket session evicted (user inactive/deleted)', { userId: ws.userId, orgId: ws.orgId });
      return false;
    }

    return true;
  } catch (err) {
    logger.warn('WebSocket revalidation error', { error: err instanceof Error ? err.message : String(err) });
    return true; // fail open
  }
}

// ─── Origin check ────────────────────────────────────────────
function isOriginAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // No origin = non-browser (curl, etc.)
  return CORS_ORIGINS.includes(origin);
}

// ─── Extract client IP ──────────────────────────────────────
function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : forwarded[0];
  }
  return req.socket?.remoteAddress || 'unknown';
}

// ─── Payload sanitization ───────────────────────────────────
function truncateField(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length > maxLen ? value.slice(0, maxLen) : value;
}

function sanitizeEvent(event: RealtimeEvent): RealtimeEvent {
  // Only allow known fields, truncate string values
  const sanitized: RealtimeEvent = {
    type: ALLOWED_EVENT_TYPES.has(event.type) ? event.type : 'email.received',
  };

  if (event.inbox_id) sanitized.inbox_id = truncateField(event.inbox_id, 64);
  if (event.inbox_address) sanitized.inbox_address = truncateField(event.inbox_address, MAX_FIELD_LENGTH);
  if (event.thread_id) sanitized.thread_id = truncateField(event.thread_id, 64);
  if (event.message_id) sanitized.message_id = truncateField(event.message_id, 64);
  if (event.subject) sanitized.subject = truncateField(event.subject, MAX_FIELD_LENGTH);
  if (event.from) sanitized.from = truncateField(event.from, MAX_FIELD_LENGTH);
  if (event.direction && ALLOWED_DIRECTIONS.has(event.direction)) sanitized.direction = event.direction;
  if (event.created_at) sanitized.created_at = truncateField(event.created_at, 64);
  // SMS fields
  if (event.phone_number_id) sanitized.phone_number_id = truncateField(event.phone_number_id, 64);
  if (event.from_number) sanitized.from_number = truncateField(event.from_number, 32);
  if (event.to_number) sanitized.to_number = truncateField(event.to_number, 32);

  return sanitized;
}

// ─── Redis pub/sub for cross-replica WebSocket sync ──────────
function setupRedisSubscription(): void {
  const sub = getSubClient();
  if (!sub) {
    logger.warn('Redis not available — cross-replica WebSocket sync disabled');
    return;
  }

  sub.psubscribe('realtime:org:*', (err) => {
    if (err) {
      logger.error('Redis psubscribe failed', { error: err.message });
    } else {
      logger.info('Subscribed to Redis realtime channels for cross-replica sync');
    }
  });

  sub.on('pmessage', (_pattern: string, _channel: string, message: string) => {
    try {
      const { orgId, event, sourceReplicaId } = JSON.parse(message) as {
        orgId: string;
        event: RealtimeEvent;
        sourceReplicaId: string;
      };

      // Skip events this replica published — already delivered locally in emit()
      const myReplicaId = process.env.RAILWAY_REPLICA_ID || 'local';
      if (sourceReplicaId === myReplicaId) return;

      // Deliver to WebSocket clients connected to this replica
      emitToLocalClients(orgId, event);
    } catch (err) {
      logger.warn('Redis pmessage parse error', { error: (err as Error).message });
    }
  });
}

// ─── WebSocket Server Setup ──────────────────────────────────
let wss: WebSocketServer | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let revalidationTimer: NodeJS.Timeout | null = null;

function attachToServer(httpServer: HttpServer): WebSocketServer {
  wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
  });

  httpServer.on('upgrade', async (req, socket, head) => {
    // Only handle /ws path — let voice bridge handle /ws/voice/* paths
    const pathname = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`).pathname;
    if (pathname.startsWith('/ws/voice/')) {
      return;  // Voice bridge handles this — do NOT destroy
    }
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }

    if (!isOriginAllowed(req)) {
      logger.warn('WebSocket origin rejected', { origin: req.headers.origin });
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    // ─── Per-IP connection rate limiting ───────────────────────
    const clientIp = getClientIp(req);
    if (isIpRateLimited(clientIp)) {
      logger.warn('WebSocket connection rate limited', { ip: clientIp });
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }

    const auth = await authenticateUpgrade(req);
    if (!auth) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // ─── Connection limits ────────────────────────────────────
    if (getOrgConnectionCount(auth.orgId) >= MAX_CONNECTIONS_PER_ORG) {
      logger.warn('WebSocket org connection limit reached', { orgId: auth.orgId, limit: MAX_CONNECTIONS_PER_ORG });
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }

    if (getUserConnectionCount(auth.userId) >= MAX_CONNECTIONS_PER_USER) {
      logger.warn('WebSocket user connection limit reached', { userId: auth.userId, limit: MAX_CONNECTIONS_PER_USER });
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }

    wss!.handleUpgrade(req, socket, head, (ws) => {
      const authedWs = ws as AuthenticatedSocket;
      authedWs.orgId = auth.orgId;
      authedWs.userId = auth.userId;
      authedWs.isAlive = true;
      authedWs.clientMessageCount = 0;
      authedWs.tokenExp = auth.tokenExp;

      wss!.emit('connection', authedWs, req);
    });
  });

  wss.on('connection', (ws: AuthenticatedSocket) => {
    const room = getRoom(ws.orgId);
    room.add(ws);
    trackUserConnect(ws.userId);

    logger.info('WebSocket connected', {
      userId: ws.userId,
      roomSize: room.size,
    });

    // Send ack — do NOT include orgId or any internal identifiers
    safeSend(ws, { type: 'connection.ack' });

    // ─── Reject client-sent messages ──────────────────────────
    // This is a server→client push channel only. Clients should not
    // send data frames. Track violations and disconnect abusers.
    ws.on('message', () => {
      ws.clientMessageCount++;
      if (ws.clientMessageCount >= MAX_CLIENT_MESSAGES_BEFORE_KICK) {
        logger.warn('WebSocket client sending too many messages, disconnecting', {
          userId: ws.userId,
          count: ws.clientMessageCount,
        });
        ws.close(4008, 'Unexpected client messages');
      }
    });

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('close', () => {
      removeFromRoom(ws);
      logger.info('WebSocket disconnected', { userId: ws.userId });
    });

    ws.on('error', (err) => {
      logger.warn('WebSocket error', { userId: ws.userId, error: err.message });
      removeFromRoom(ws);
    });
  });

  // ─── Heartbeat: detect dead connections ─────────────────────
  heartbeatTimer = setInterval(() => {
    if (!wss) return;
    for (const ws of wss.clients) {
      const authedWs = ws as AuthenticatedSocket;
      if (!authedWs.isAlive) {
        removeFromRoom(authedWs);
        authedWs.terminate();
        continue;
      }
      authedWs.isAlive = false;
      authedWs.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  // ─── Periodic session revalidation ─────────────────────────
  // Evict connections with expired JWTs or deactivated users
  revalidationTimer = setInterval(async () => {
    if (!wss) return;
    const clients = Array.from(wss.clients) as AuthenticatedSocket[];
    for (const ws of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const valid = await revalidateSession(ws);
      if (!valid) {
        safeSend(ws, { type: 'connection.ack', status: 'session_expired' });
        ws.close(4001, 'Session expired');
        removeFromRoom(ws);
      }
    }
  }, REVALIDATION_INTERVAL_MS);

  logger.info('WebSocket server attached to /ws path (hardened)');

  // Set up Redis pub/sub for cross-replica event delivery
  setupRedisSubscription();

  return wss;
}

// ─── Deliver to local WebSocket clients only (no Redis publish) ──
// Used by the Redis subscriber to forward cross-replica events
// without re-publishing and creating a loop.
function emitToLocalClients(orgId: string, event: RealtimeEvent): void {
  const room = rooms.get(orgId);
  if (!room || room.size === 0) return;

  const sanitized = sanitizeEvent(event);
  const payload = JSON.stringify(sanitized);

  for (const ws of room) {
    safeSend(ws, payload);
  }

  logger.info('Realtime event delivered from cross-replica pub/sub', {
    type: sanitized.type,
    roomSize: room.size,
    messageId: sanitized.message_id,
  });
}

// ─── Emit to all connections in an org ───────────────────────
function emit(orgId: string, event: RealtimeEvent): void {
  const room = rooms.get(orgId);
  if (!room || room.size === 0) return;

  // Sanitize before broadcasting — strip unknown fields, truncate values
  const sanitized = sanitizeEvent(event);
  const payload = JSON.stringify(sanitized);

  for (const ws of room) {
    safeSend(ws, payload);
  }

  logger.info('Realtime event emitted', {
    type: sanitized.type,
    roomSize: room.size,
    messageId: sanitized.message_id,
  });

  // Publish to Redis so other replicas can deliver the event to their local clients.
  // Fire-and-forget — Redis being down must not break local WebSocket delivery.
  const pub = getRedisClient();
  if (pub) {
    pub.publish(
      `realtime:org:${orgId}`,
      JSON.stringify({
        orgId,
        event: sanitized,
        sourceReplicaId: process.env.RAILWAY_REPLICA_ID || 'local',
      })
    ).catch((err) => logger.warn('Redis realtime publish failed', { error: (err as Error).message }));
  }
}

function safeSend(ws: WebSocket, data: any): void {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      ws.send(payload);
    }
  } catch {
    // Swallow send errors — connection will be cleaned up by heartbeat
  }
}

// ─── Stats (redacted — no org IDs exposed) ──────────────────
function getStats() {
  const roomSizes = Array.from(rooms.values()).map(set => set.size);
  return {
    totalConnections: wss ? wss.clients.size : 0,
    totalRooms: rooms.size,
    maxRoomSize: roomSizes.length > 0 ? Math.max(...roomSizes) : 0,
    avgRoomSize: roomSizes.length > 0 ? Math.round(roomSizes.reduce((a, b) => a + b, 0) / roomSizes.length) : 0,
  };
}

function shutdown(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (revalidationTimer) {
    clearInterval(revalidationTimer);
    revalidationTimer = null;
  }
  if (wss) {
    for (const ws of wss.clients) {
      ws.close(1001, 'Server shutting down');
    }
    wss.close();
    wss = null;
  }
  rooms.clear();
  userConnectionCounts.clear();
  ipConnectionLog.clear();
}

export default {
  attachToServer,
  emit,
  getStats,
  shutdown,
};
