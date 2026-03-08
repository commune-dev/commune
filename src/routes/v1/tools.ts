import { Router } from 'express';
import { z } from 'zod';
import dns from 'dns';
import { randomUUID } from 'crypto';
import * as toolStore from '../../stores/toolStore';
import { resolveOrgTier } from '../../lib/tierResolver';
import { hasFeature } from '../../config/rateLimits';
import { encrypt, decrypt } from '../../lib/encryption';
import logger from '../../utils/logger';
import type { ToolWebhookImpl } from '../../types/voice';

const router = Router();

// ─── Constants ────────────────────────────────────────────────────

const TOOL_NAME_REGEX = /^[a-zA-Z0-9_]{1,64}$/;
const MAX_TOOLS_PER_ORG = 50;

// ─── SSRF validation ──────────────────────────────────────────────

const PRIVATE_IPV4_RANGES = [
  // Loopback
  (ip: string) => ip === '127.0.0.1' || ip.startsWith('127.'),
  // RFC 1918
  (ip: string) => ip.startsWith('10.'),
  (ip: string) => {
    const parts = ip.split('.').map(Number);
    return parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
  },
  (ip: string) => ip.startsWith('192.168.'),
  // Link-local
  (ip: string) => ip.startsWith('169.254.'),
  // This network
  (ip: string) => ip.startsWith('0.'),
  // CGNAT
  (ip: string) => {
    const parts = ip.split('.').map(Number);
    return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
  },
];

const PRIVATE_IPV6_RANGES = [
  (ip: string) => ip === '::1',
  (ip: string) => ip.startsWith('fc') || ip.startsWith('fd'),  // fc00::/7 ULA
  (ip: string) => ip.startsWith('fe80'),                        // fe80::/10 link-local
  (ip: string) => ip.startsWith('::ffff:'),                     // IPv4-mapped
  (ip: string) => ip.startsWith('64:ff9b:'),                    // NAT64
];

function isPrivateIp(ip: string): boolean {
  const lc = ip.toLowerCase();
  const isV6 = lc.includes(':');
  if (isV6) return PRIVATE_IPV6_RANGES.some(fn => fn(lc));
  return PRIVATE_IPV4_RANGES.some(fn => fn(ip));
}

async function validateWebhookUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Webhook URL must use HTTPS');
  }

  // Resolve both A and AAAA records
  const [ipv4Result, ipv6Result] = await Promise.allSettled([
    dns.promises.resolve4(parsed.hostname),
    dns.promises.resolve6(parsed.hostname),
  ]);

  const allIps = [
    ...(ipv4Result.status === 'fulfilled' ? ipv4Result.value : []),
    ...(ipv6Result.status === 'fulfilled' ? ipv6Result.value : []),
  ];

  if (allIps.length === 0) {
    throw new Error('Unable to resolve webhook hostname');
  }

  for (const ip of allIps) {
    if (isPrivateIp(ip)) {
      throw new Error(`Webhook URL resolves to a private or reserved IP address`);
    }
  }
}

// ─── Serializers ─────────────────────────────────────────────────

function serializeTool(tool: any, includeSecret = false) {
  const impl = { ...tool.implementation };
  if (!includeSecret) {
    delete impl.webhookSecret;  // never expose encrypted secret in API responses
  } else {
    // Caller requested plain secret (only at creation time)
    // impl.webhookSecret is already the plaintext at this point
  }
  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    implementation: impl,
    version: tool.version,
    lastTestedAt: tool.lastTestedAt ?? null,
    lastTestResult: tool.lastTestResult ?? null,
    lastTestDurationMs: tool.lastTestDurationMs ?? null,
    createdAt: tool.createdAt,
    updatedAt: tool.updatedAt,
  };
}

// ─── Zod schemas ──────────────────────────────────────────────────

const ToolImplSchema = z.object({
  url: z.string().url().startsWith('https://'),
  method: z.enum(['POST', 'GET']).default('POST'),
  headers: z.record(z.string()).optional(),
  timeoutMs: z.number().min(1000).max(30000).default(8000),
  retries: z.number().min(0).max(3).default(1),
});

const CreateToolSchema = z.object({
  name: z.string().regex(TOOL_NAME_REGEX, 'Tool name must match /^[a-zA-Z0-9_]{1,64}$/'),
  description: z.string().max(1024),
  parameters: z.record(z.unknown()),
  webhook: ToolImplSchema,
});

const UpdateToolSchema = z.object({
  name: z.string().regex(TOOL_NAME_REGEX).optional(),
  description: z.string().max(1024).optional(),
  parameters: z.record(z.unknown()).optional(),
  webhook: ToolImplSchema.partial().optional(),
});

// ─── Routes ───────────────────────────────────────────────────────

// GET /v1/tools
router.get('/', async (req: any, res) => {
  try {
    const orgId: string = req.orgId;
    const tier = await resolveOrgTier(orgId);
    if (!hasFeature(tier, 'voiceCalling')) {
      return res.status(403).json({ error: 'Voice calling requires agent_pro plan or higher' });
    }

    const tools = await toolStore.listTools(orgId);
    return res.json({ data: tools.map(t => serializeTool(t)) });
  } catch (err) {
    logger.error('GET /v1/tools error', { err });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /v1/tools
router.post('/', async (req: any, res) => {
  try {
    const orgId: string = req.orgId;
    const tier = await resolveOrgTier(orgId);
    if (!hasFeature(tier, 'voiceCalling')) {
      return res.status(403).json({ error: 'Voice calling requires agent_pro plan or higher' });
    }

    const body = CreateToolSchema.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid request' });
    }

    // Cap tools per org
    const existing = await toolStore.listTools(orgId);
    if (existing.length >= MAX_TOOLS_PER_ORG) {
      return res.status(400).json({ error: `Maximum ${MAX_TOOLS_PER_ORG} tools per organization` });
    }

    // SSRF validation
    try {
      await validateWebhookUrl(body.data.webhook.url);
    } catch (err) {
      return res.status(400).json({ error: `Webhook URL validation failed: ${(err as Error).message}` });
    }

    // Generate webhook secret — shown ONCE
    const webhookSecret = randomUUID().replace(/-/g, '');
    const encryptedSecret = encrypt(webhookSecret);

    const implementation: ToolWebhookImpl = {
      type: 'webhook',
      url: body.data.webhook.url,
      method: body.data.webhook.method ?? 'POST',
      headers: body.data.webhook.headers,
      webhookSecret: encryptedSecret,
      timeoutMs: body.data.webhook.timeoutMs ?? 8000,
      retries: body.data.webhook.retries ?? 1,
    };

    const tool = await toolStore.createTool(orgId, {
      name: body.data.name,
      description: body.data.description,
      parameters: body.data.parameters,
      implementation,
    });

    // Return tool with plaintext secret (only time it's visible)
    const response = {
      data: serializeTool(tool),
      webhookSecret,  // plaintext — user must save this now
    };

    return res.status(201).json(response);
  } catch (err) {
    logger.error('POST /v1/tools error', { err });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /v1/tools/:id
router.get('/:id', async (req: any, res) => {
  try {
    const orgId: string = req.orgId;
    const tool = await toolStore.getToolById(orgId, req.params.id);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });
    return res.json({ data: serializeTool(tool) });
  } catch (err) {
    logger.error('GET /v1/tools/:id error', { err });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /v1/tools/:id
router.patch('/:id', async (req: any, res) => {
  try {
    const orgId: string = req.orgId;
    const body = UpdateToolSchema.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid request' });
    }

    const existing = await toolStore.getToolById(orgId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Tool not found' });

    const updates: Parameters<typeof toolStore.updateTool>[2] = {};
    if (body.data.name !== undefined) updates.name = body.data.name;
    if (body.data.description !== undefined) updates.description = body.data.description;
    if (body.data.parameters !== undefined) updates.parameters = body.data.parameters;

    if (body.data.webhook) {
      const wb = body.data.webhook;

      // Validate new URL if changed
      const newUrl = wb.url ?? existing.implementation.url;
      if (wb.url && wb.url !== existing.implementation.url) {
        try {
          await validateWebhookUrl(newUrl);
        } catch (err) {
          return res.status(400).json({ error: `Webhook URL validation failed: ${(err as Error).message}` });
        }
      }

      updates.implementation = {
        ...existing.implementation,
        url: newUrl,
        method: wb.method ?? existing.implementation.method,
        headers: wb.headers ?? existing.implementation.headers,
        timeoutMs: wb.timeoutMs ?? existing.implementation.timeoutMs,
        retries: wb.retries ?? existing.implementation.retries,
      };
    }

    const updated = await toolStore.updateTool(orgId, req.params.id, updates);
    if (!updated) return res.status(404).json({ error: 'Tool not found' });

    return res.json({ data: serializeTool(updated) });
  } catch (err) {
    logger.error('PATCH /v1/tools/:id error', { err });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /v1/tools/:id
router.delete('/:id', async (req: any, res) => {
  try {
    const orgId: string = req.orgId;

    // Check if any voice agent is using this tool
    const inUse = await toolStore.isToolInUse(orgId, req.params.id);
    if (inUse) {
      return res.status(409).json({
        error: 'Tool is in use by one or more phone number voice agents. Remove it from all agents first.',
      });
    }

    const deleted = await toolStore.deleteTool(orgId, req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Tool not found' });

    return res.status(204).end();
  } catch (err) {
    logger.error('DELETE /v1/tools/:id error', { err });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /v1/tools/:id/test
// Test a tool webhook with sample arguments — no live call needed
router.post('/:id/test', async (req: any, res) => {
  try {
    const orgId: string = req.orgId;
    const tool = await toolStore.getToolById(orgId, req.params.id);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });

    const args = req.body?.args ?? {};
    const startMs = Date.now();

    // Re-validate webhook URL at test time (DNS rebinding defense)
    try {
      await validateWebhookUrl(tool.implementation.url);
    } catch (err) {
      return res.status(400).json({ error: `Webhook URL blocked: ${(err as Error).message}` });
    }

    let plainSecret: string;
    try {
      plainSecret = decrypt(tool.implementation.webhookSecret);
    } catch {
      plainSecret = '';
    }

    const timestamp = Date.now();
    const body = JSON.stringify(args);
    const hmacPayload = `${timestamp}.${body}`;
    const { createHmac } = await import('crypto');
    const signature = plainSecret
      ? createHmac('sha256', plainSecret).update(hmacPayload).digest('hex')
      : '';

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Commune-Timestamp': String(timestamp),
      ...(tool.implementation.headers ?? {}),
    };
    if (signature) headers['X-Commune-Signature'] = `sha256=${signature}`;

    let testResult: 'success' | 'failure' = 'failure';
    let responseBody: unknown = null;
    let statusCode = 0;
    let error: string | undefined;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.min(tool.implementation.timeoutMs, 10000));

      const response = await fetch(tool.implementation.url, {
        method: tool.implementation.method,
        redirect: 'error',  // block redirect chains (SSRF defense)
        headers,
        body: tool.implementation.method === 'POST' ? body : undefined,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      statusCode = response.status;
      if (response.ok) {
        try {
          responseBody = await response.json();
        } catch {
          responseBody = await response.text();
        }
        testResult = 'success';
      } else {
        error = `HTTP ${response.status}`;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Unknown error';
    }

    const durationMs = Date.now() - startMs;

    // Update tool's last test metadata
    await toolStore.updateTool(orgId, req.params.id, {
      lastTestedAt: new Date(),
      lastTestResult: testResult,
      lastTestDurationMs: durationMs,
    });

    return res.json({
      data: {
        result: testResult,
        statusCode,
        durationMs,
        response: responseBody,
        error: error ?? null,
      },
    });
  } catch (err) {
    logger.error('POST /v1/tools/:id/test error', { err });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
