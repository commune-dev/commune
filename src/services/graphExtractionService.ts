/**
 * Graph Extraction Service
 *
 * Runs after every inbound/outbound email (debounced per thread).
 * Extracts contacts, relationships, topics, and conversation state
 * using Azure OpenAI — then maintains a per-org canonical vocabulary
 * so the same concept is always stored under the same label.
 *
 * Vocabulary problem solved by:
 * 1. Fetching existing org vocabulary before each extraction
 * 2. Injecting it into the LLM prompt so the model reuses existing terms
 * 3. Post-processing with Jaccard token similarity to catch divergent phrasing
 * 4. Updating the canonical vocabulary after each successful extraction
 */

import { getCollection } from '../db';
import { decrypt } from '../lib/encryption';
import logger from '../utils/logger';

// ─── Azure config ─────────────────────────────────────────────────────────────

const AZURE_ENDPOINT  = process.env.AZURE_OPENAI_ENDPOINT || '';
const AZURE_KEY       = process.env.AZURE_OPENAI_API_KEY  || '';
const AZURE_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';
const API_VERSION     = '2024-08-01-preview';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GraphExtraction {
  thread_status:   'active' | 'waiting' | 'resolved' | 'stalled' | 'closed';
  thread_category: string;   // inferred by LLM, normalized to org vocabulary
  sentiment:       'positive' | 'neutral' | 'negative' | 'mixed';
  urgency:         'high' | 'medium' | 'low';
  topics:          string[]; // normalized to org vocabulary
  summary:         string;
  next_action:     string;
  key_contacts: Array<{
    email:        string;
    name:         string;
    role:         string;
    organization: string;
    sentiment:    string;
  }>;
  relationships: Array<{
    from: string;
    to:   string;
    type: string;
  }>;
}

interface OrgVocabulary {
  categories: string[];
  topics:     string[];
}

// ─── Debounce ─────────────────────────────────────────────────────────────────
// One 30-second timer per thread. Resets on each new message so rapid
// back-and-forth only triggers one extraction after the thread settles.

const pending = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 30_000;

// ─── Public API ───────────────────────────────────────────────────────────────

export function scheduleGraphExtraction(
  threadId: string | undefined,
  orgId:    string | undefined,
): void {
  if (!threadId || !orgId) return;
  if (!AZURE_ENDPOINT || !AZURE_KEY) return;

  const prev = pending.get(threadId);
  if (prev) clearTimeout(prev);

  const handle = setTimeout(() => {
    pending.delete(threadId);
    runExtraction(threadId, orgId).catch((err) =>
      logger.error('Graph extraction error', {
        threadId, orgId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }, DEBOUNCE_MS);

  pending.set(threadId, handle);
}

export default { scheduleGraphExtraction };

// ─── Vocabulary: fetch ────────────────────────────────────────────────────────
// Returns the top-used categories and topics for this org so we can
// inject them into the LLM prompt and use them for post-normalization.

async function getOrgVocabulary(orgId: string): Promise<OrgVocabulary> {
  const col = await getCollection('graph_vocabulary');
  if (!col) return { categories: [], topics: [] };

  const docs = await col
    .find({ orgId })
    .sort({ count: -1 })
    .limit(80)
    .toArray() as unknown as Array<{ type: string; value: string; count: number }>;

  return {
    categories: docs.filter((d) => d.type === 'category').slice(0, 25).map((d) => d.value),
    topics:     docs.filter((d) => d.type === 'topic').slice(0, 40).map((d) => d.value),
  };
}

// ─── Vocabulary: normalize ────────────────────────────────────────────────────
// Tries to match a raw LLM-generated string to an existing vocabulary entry.
// First checks for exact match after normalization (handles spaces vs underscores,
// capitalisation differences). Then falls back to Jaccard token similarity.
// Only replaces if similarity ≥ 60% — otherwise the new term is genuinely novel.

function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s\-/]+/g, '_').replace(/[^a-z0-9_]/g, '').trim();
}

function tokenize(s: string): Set<string> {
  return new Set(normalize(s).split('_').filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const intersection = [...a].filter((t) => b.has(t)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function matchToVocabulary(raw: string, existing: string[]): string {
  if (!raw || existing.length === 0) return raw;

  const rawNorm   = normalize(raw);
  const rawTokens = tokenize(raw);

  let best = { value: '', score: 0 };

  for (const ex of existing) {
    // Exact match after normalization (handles "job application" vs "job_application")
    if (normalize(ex) === rawNorm) return ex;

    const score = jaccard(rawTokens, tokenize(ex));
    if (score > best.score) best = { value: ex, score };
  }

  // Threshold: 0.6 Jaccard — "support_request" matches "support_ticket" (0.67)
  // but "bug_report" does NOT match "partnership_inquiry" (0.0)
  return best.score >= 0.6 ? best.value : raw;
}

// ─── Vocabulary: update ───────────────────────────────────────────────────────
// Upserts normalized category + topics into the org vocabulary with a usage count.
// The count is used to rank which terms appear in future LLM prompts.

async function updateVocabulary(
  orgId:    string,
  category: string,
  topics:   string[],
): Promise<void> {
  const col = await getCollection('graph_vocabulary');
  if (!col) return;

  const now  = new Date().toISOString();
  const entries = [
    { type: 'category', value: category },
    ...topics.map((t) => ({ type: 'topic', value: t })),
  ];

  await Promise.all(
    entries
      .filter((e) => e.value && e.value.trim().length > 0)
      .map((e) =>
        col.updateOne(
          { orgId, type: e.type, value: e.value },
          {
            $inc: { count: 1 },
            $set: { updated_at: now },
            $setOnInsert: {
              orgId,
              type:       e.type,
              value:      e.value,
              count:      0,
              created_at: now,
            },
          },
          { upsert: true },
        ),
      ),
  );
}

// ─── Core extraction ──────────────────────────────────────────────────────────

async function runExtraction(threadId: string, orgId: string): Promise<void> {
  const messagesCol = await getCollection('messages');
  if (!messagesCol) return;

  const rawMessages = await messagesCol
    .find({ orgId, thread_id: threadId })
    .sort({ created_at: 1 })
    .toArray() as Array<Record<string, unknown>>;

  if (rawMessages.length === 0) return;

  // Build own addresses and ALL unique participant emails from raw message headers.
  // We pass these to the LLM so it anchors to real addresses (no hallucination).
  const ownAddresses = new Set<string>();
  const allParticipantEmails = new Set<string>();

  for (const msg of rawMessages) {
    const meta = (msg.metadata as Record<string, unknown>) || {};
    const addr = safeDecrypt(meta.inbox_address as unknown);
    if (addr) ownAddresses.add(addr.toLowerCase().trim());

    const participants = (msg.participants as Array<{ role: string; identity: string }>) || [];
    for (const p of participants) {
      const email = safeDecrypt(p.identity || '').toLowerCase().trim();
      if (email && email.includes('@')) allParticipantEmails.add(email);
    }
  }

  // For large threads, use first 3 + last 7 messages to stay within token limits
  const msgs = rawMessages.length > 10
    ? [...rawMessages.slice(0, 3), ...rawMessages.slice(-7)]
    : rawMessages;

  const messages = msgs.map((msg) => {
    const meta         = (msg.metadata as Record<string, unknown>) || {};
    const participants = (msg.participants as Array<{ role: string; identity: string }>) || [];

    const from = safeDecrypt(participants.find((p) => p.role === 'sender')?.identity || '');
    const to   = participants.filter((p) => p.role === 'to').map((p) => safeDecrypt(p.identity));
    const cc   = participants.filter((p) => p.role === 'cc').map((p) => safeDecrypt(p.identity));

    return {
      from,
      to,
      cc,
      subject:   safeDecrypt(meta.subject as string || ''),
      body:      safeDecrypt(String(msg.content || '')).slice(0, 1000),
      date:      String(msg.created_at || ''),
      direction: String(msg.direction || ''),
    };
  });

  const subject = messages[0].subject || '(no subject)';
  const emailChain = messages
    .map((m, i) => {
      const cc = m.cc.length > 0 ? `CC: ${m.cc.join(', ')}\n` : '';
      return `--- Message ${i + 1} (${m.direction}) ---\nFrom: ${m.from}\nTo: ${m.to.join(', ')}\n${cc}Date: ${m.date}\n\n${m.body}`;
    })
    .join('\n\n');

  // Participant list injected into prompt — LLM must only use these emails
  const participantList = [...allParticipantEmails].join(', ');

  // Fetch org vocabulary so we can inject it into the prompt
  const vocab = await getOrgVocabulary(orgId);

  const raw = await callAzureOpenAI(subject, emailChain, vocab, participantList);
  if (!raw) return;

  // Normalize category and topics against existing vocabulary
  // This catches cases where the LLM invented a near-synonym
  const category = matchToVocabulary(raw.thread_category, vocab.categories);
  const topics   = raw.topics.map((t) => matchToVocabulary(t, vocab.topics));

  const extraction: GraphExtraction = { ...raw, thread_category: category, topics };

  // Persist to thread_metadata
  const metaCol = await getCollection('thread_metadata');
  if (metaCol) {
    await metaCol.updateOne(
      { thread_id: threadId, orgId },
      {
        $set: {
          extracted_data:       extraction,
          graph_extracted_at:   new Date().toISOString(),
          updated_at:           new Date().toISOString(),
          own_addresses:        [...ownAddresses], // store for graph API reference
        },
        $setOnInsert: {
          thread_id:  threadId,
          orgId,
          tags:       [],
          status:     'open',
          created_at: new Date().toISOString(),
        },
      },
      { upsert: true },
    );
  }

  // Update org vocabulary with the normalized values
  await updateVocabulary(orgId, category, topics);

  logger.info('Graph extraction complete', {
    threadId,
    orgId,
    status:   extraction.thread_status,
    category,
    topics:   topics.slice(0, 4),
    contacts: extraction.key_contacts.length,
  });
}

// ─── Azure OpenAI call ────────────────────────────────────────────────────────

async function callAzureOpenAI(
  subject:          string,
  emailChain:       string,
  vocab:            OrgVocabulary,
  participantList:  string,
): Promise<GraphExtraction | null> {
  const url = `${AZURE_ENDPOINT}/openai/deployments/${AZURE_DEPLOYMENT}/chat/completions?api-version=${API_VERSION}`;

  // Vocabulary hints — only included when the org has established vocabulary
  const categoryHint = vocab.categories.length > 0
    ? `\nExisting categories in use by this organization — PREFER these if they fit, only create new if none apply:\n${vocab.categories.join(', ')}\n`
    : '';
  const topicHint = vocab.topics.length > 0
    ? `\nExisting topics in use — PREFER these exact strings where applicable:\n${vocab.topics.join(', ')}\n`
    : '';

  const systemPrompt = `You are an expert at analyzing email conversations to extract structured communication intelligence. You work across all contexts — support, recruiting, sales, partnerships, legal, internal ops, and more. Never assume the context; infer it from the content. Return valid JSON only.`;

  // We already know dates, direction, message count, and participant emails from the database.
  // The LLM's job is ONLY to provide semantic enrichment that cannot be computed from raw data:
  // category, status, sentiment, urgency, topics, summary, next action, contact names/roles/orgs.
  const participantHint = participantList
    ? `\nKnown participants (from email headers — use ONLY these email addresses in key_contacts and relationships, do not invent new ones):\n${participantList}\n`
    : '';

  const userPrompt = `Analyze this email thread and extract communication intelligence.

Subject: ${subject}
${categoryHint}${topicHint}${participantHint}
${emailChain}

Return a JSON object. Context rules:
- Do NOT assume this is a sales conversation — infer the actual context from content.
- thread_category: what kind of conversation? Infer freely. Examples: support_request, job_application, partnership_inquiry, investor_outreach, customer_onboarding, internal_coordination, billing_issue, product_feedback, legal_review, vendor_negotiation, cold_outreach, community, introduction. Prefer existing categories listed above.
- topics: specific subjects discussed. Prefer existing topics above. Add new ones only if genuinely different.
- thread_status: active=ongoing exchange, waiting=awaiting reply, resolved=concluded positively, stalled=no progress, closed=ended
- key_contacts: read names, roles, and organizations from email signatures and how people introduce themselves. Use ONLY email addresses from the Known participants list — never invent new ones. Skip contacts you cannot confidently enrich.
- relationships: infer from CC patterns, forwarding, and how people refer to each other. Use only known participant emails.
- summary: one concise sentence describing what this thread is about and its current state.
- next_action: one concrete actionable sentence describing what needs to happen next (who should do what). Empty string if resolved/closed.`;

  const body = {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'graph_extraction',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            thread_status: {
              type: 'string',
              enum: ['active', 'waiting', 'resolved', 'stalled', 'closed'],
            },
            thread_category: { type: 'string' },
            sentiment: {
              type: 'string',
              enum: ['positive', 'neutral', 'negative', 'mixed'],
            },
            urgency: {
              type: 'string',
              enum: ['high', 'medium', 'low'],
            },
            topics:      { type: 'array', items: { type: 'string' } },
            summary:     { type: 'string' },
            next_action: { type: 'string' },
            key_contacts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  email:        { type: 'string' },
                  name:         { type: 'string' },
                  role:         { type: 'string' },
                  organization: { type: 'string' },
                  sentiment:    { type: 'string' },
                },
                required: ['email', 'name', 'role', 'organization', 'sentiment'],
                additionalProperties: false,
              },
            },
            relationships: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  from: { type: 'string' },
                  to:   { type: 'string' },
                  type: { type: 'string' },
                },
                required: ['from', 'to', 'type'],
                additionalProperties: false,
              },
            },
          },
          required: [
            'thread_status', 'thread_category', 'sentiment', 'urgency',
            'topics', 'summary', 'next_action', 'key_contacts', 'relationships',
          ],
          additionalProperties: false,
        },
      },
    },
    temperature: 0.1,
    max_tokens:  1500,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': AZURE_KEY },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.warn('Azure OpenAI graph extraction HTTP error', {
        status: res.status,
        body:   text.slice(0, 300),
      });
      return null;
    }

    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    return JSON.parse(content) as GraphExtraction;
  } catch (err) {
    logger.warn('Graph extraction LLM call failed', {
      error: err instanceof Error ? err.message : err,
    });
    return null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeDecrypt(val: unknown): string {
  if (typeof val !== 'string') return '';
  try { return val.startsWith('enc:') ? decrypt(val) : val; } catch { return String(val); }
}
