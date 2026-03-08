/**
 * Graph Metadata Extraction Script
 * Runs all seeded threads through Azure OpenAI to extract rich graph metadata
 * (deal stage, topics, contacts, relationships) and stores in thread_metadata.
 *
 * Run: cd backend && npx ts-node -r dotenv/config src/scripts/extract-graph-metadata.ts
 */

import { connect, getCollection } from '../db';
import { decrypt } from '../lib/encryption';
import messageStore from '../stores/messageStore';

// ─── Azure OpenAI Config (same pattern as structuredExtractionService.ts) ────

const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || '';
const AZURE_OPENAI_KEY = process.env.AZURE_OPENAI_API_KEY || '';
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';
const API_VERSION = '2024-08-01-preview';

const DEMO_DOMAIN_NAME = 'techflow.ai';

// ─── Types ────────────────────────────────────────────────────────────────────

interface KeyContact {
  email: string;
  name: string;
  role: string;
  sentiment: string;
}

interface Relationship {
  from: string;
  to: string;
  type: string;
}

interface GraphExtraction {
  deal_stage: 'cold' | 'interested' | 'evaluating' | 'negotiating' | 'closed_won' | 'closed_lost' | 'bounced';
  sentiment: 'positive' | 'neutral' | 'negative';
  topics: string[];
  company_name: string;
  deal_value_estimate: 'high' | 'medium' | 'low';
  next_action: string;
  key_contacts: KeyContact[];
  relationships: Relationship[];
}

interface ThreadSummary {
  thread_id: string;
  orgId: string;
  subject: string;
  messages: Array<{
    from: string;
    to: string[];
    cc: string[];
    body: string;
    date: string;
    direction: string;
  }>;
  inboxId: string;
}

// ─── Azure OpenAI call ────────────────────────────────────────────────────────

async function extractGraphMetadata(thread: ThreadSummary): Promise<GraphExtraction | null> {
  if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_KEY) {
    return null;
  }

  const url = `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${API_VERSION}`;

  // Build a readable email chain
  const emailChain = thread.messages
    .map((m, i) => {
      const ccLine = m.cc.length > 0 ? `CC: ${m.cc.join(', ')}\n` : '';
      return `--- Email ${i + 1} (${m.direction}) ---\nFrom: ${m.from}\nTo: ${m.to.join(', ')}\n${ccLine}Date: ${m.date}\n\n${m.body}`;
    })
    .join('\n\n');

  const systemPrompt = `You are an expert sales analyst. Analyze email threads between an AI SDR (Sales Development Representative) at TechFlow AI and their prospects.
Extract structured information about the sales conversation. Return valid JSON only.`;

  const userPrompt = `Analyze this email thread and extract sales intelligence:

Subject: ${thread.subject}
Inbox: ${thread.inboxId}

${emailChain}

Return a JSON object with this exact schema:
{
  "deal_stage": "one of: cold, interested, evaluating, negotiating, closed_won, closed_lost, bounced",
  "sentiment": "one of: positive, neutral, negative",
  "topics": ["array of topics discussed, e.g.: pricing, security, integration, timeline, competition, compliance"],
  "company_name": "name of the prospect company",
  "deal_value_estimate": "one of: high, medium, low",
  "next_action": "brief description of what should happen next",
  "key_contacts": [
    {
      "email": "contact email",
      "name": "contact name if known",
      "role": "their role/title",
      "sentiment": "their sentiment: positive, neutral, negative, evaluating"
    }
  ],
  "relationships": [
    {
      "from": "email address",
      "to": "email address",
      "type": "relationship type: manages, works_with, reports_to, referred_to, cc_loop"
    }
  ]
}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_OPENAI_KEY,
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'graph_extraction',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                deal_stage: {
                  type: 'string',
                  enum: ['cold', 'interested', 'evaluating', 'negotiating', 'closed_won', 'closed_lost', 'bounced'],
                },
                sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
                topics: { type: 'array', items: { type: 'string' } },
                company_name: { type: 'string' },
                deal_value_estimate: { type: 'string', enum: ['high', 'medium', 'low'] },
                next_action: { type: 'string' },
                key_contacts: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      email: { type: 'string' },
                      name: { type: 'string' },
                      role: { type: 'string' },
                      sentiment: { type: 'string' },
                    },
                    required: ['email', 'name', 'role', 'sentiment'],
                    additionalProperties: false,
                  },
                },
                relationships: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      from: { type: 'string' },
                      to: { type: 'string' },
                      type: { type: 'string' },
                    },
                    required: ['from', 'to', 'type'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['deal_stage', 'sentiment', 'topics', 'company_name', 'deal_value_estimate', 'next_action', 'key_contacts', 'relationships'],
              additionalProperties: false,
            },
          },
        },
        temperature: 0.1,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`    Azure OpenAI error (${response.status}): ${errText.slice(0, 200)}`);
      return null;
    }

    const data = await response.json() as { choices: Array<{ message: { content: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    return JSON.parse(content) as GraphExtraction;
  } catch (err) {
    console.error(`    Extraction error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ─── Fetch threads for domain ─────────────────────────────────────────────────

async function getThreadsForDomain(orgId: string): Promise<ThreadSummary[]> {
  const messagesCol = await getCollection('messages');
  if (!messagesCol) return [];

  // Get all messages in techflow.ai domain
  const rawMessages = await messagesCol
    .find({ orgId, 'metadata.inbox_address': { $regex: DEMO_DOMAIN_NAME } })
    .sort({ created_at: 1 })
    .toArray() as Array<Record<string, unknown>>;

  // Group by thread_id
  const threadMap = new Map<string, Array<Record<string, unknown>>>();
  for (const msg of rawMessages) {
    const tid = String(msg.thread_id || msg.message_id || '');
    if (!threadMap.has(tid)) threadMap.set(tid, []);
    threadMap.get(tid)!.push(msg);
  }

  const threads: ThreadSummary[] = [];

  for (const [threadId, msgs] of threadMap.entries()) {
    const first = msgs[0];
    const rawSubject = first.metadata && typeof first.metadata === 'object'
      ? (first.metadata as Record<string, unknown>).subject as string
      : '';
    const subject = rawSubject ? decrypt(rawSubject) : '(no subject)';

    const summaryMessages = msgs.map((msg) => {
      const rawContent = String(msg.content || '');
      const body = rawContent.startsWith('enc:') ? decrypt(rawContent) : rawContent;
      const meta = msg.metadata as Record<string, unknown> || {};
      const participants = (msg.participants as Array<{ role: string; identity: string }>) || [];

      const decryptedParticipants = participants.map((p) => ({
        ...p,
        identity: p.identity?.startsWith?.('enc:') ? decrypt(p.identity) : p.identity,
      }));

      const from = decryptedParticipants.find((p) => p.role === 'sender')?.identity || '';
      const to = decryptedParticipants.filter((p) => p.role === 'to').map((p) => p.identity);
      const cc = decryptedParticipants.filter((p) => p.role === 'cc').map((p) => p.identity);

      return {
        from,
        to,
        cc,
        body: body.slice(0, 1000), // Trim for token efficiency
        date: String(msg.created_at || ''),
        direction: String(msg.direction || ''),
      };
    });

    threads.push({
      thread_id: threadId,
      orgId,
      subject,
      messages: summaryMessages,
      inboxId: String((msgs[0].metadata as Record<string, unknown>)?.inbox_id || ''),
    });
  }

  return threads;
}

// ─── Update thread metadata ───────────────────────────────────────────────────

async function updateThreadMetadata(threadId: string, orgId: string, extraction: GraphExtraction): Promise<void> {
  const col = await getCollection('thread_metadata');
  if (!col) return;

  await col.updateOne(
    { thread_id: threadId, orgId },
    {
      $set: {
        extracted_data: extraction,
        updated_at: new Date().toISOString(),
      },
      $setOnInsert: {
        thread_id: threadId,
        orgId,
        tags: [],
        status: 'open',
      },
    },
    { upsert: true },
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🧠 Graph Metadata Extraction Script');
  console.log('====================================\n');

  const configured = !!(AZURE_OPENAI_ENDPOINT && AZURE_OPENAI_KEY);
  if (!configured) {
    console.warn('⚠️  AZURE_OPENAI_ENDPOINT or AZURE_OPENAI_API_KEY not set.');
    console.warn('   Graph metadata will use pre-seeded data from seed script.\n');
  } else {
    console.log(`✅ Azure OpenAI: ${AZURE_OPENAI_ENDPOINT} (deployment: ${AZURE_OPENAI_DEPLOYMENT})\n`);
  }

  console.log('📡 Connecting to MongoDB...');
  const db = await connect();
  if (!db) {
    console.error('❌ Failed to connect to MongoDB.');
    process.exit(1);
  }
  console.log(`✅ Connected to ${db.databaseName}\n`);

  // Find orgId
  const usersCol = await getCollection('users');
  let orgId: string | null = null;
  if (usersCol) {
    const user = await usersCol.findOne({ email: { $regex: 'shanjai', $options: 'i' } }) as { orgId?: string } | null;
    orgId = user?.orgId || null;
  }
  if (!orgId) {
    const orgsCol = await getCollection('organizations');
    const org = orgsCol ? await orgsCol.findOne({}) as { id?: string } | null : null;
    orgId = org?.id || null;
  }

  if (!orgId) {
    console.error('❌ Could not find orgId. Run seed script first.');
    process.exit(1);
  }

  console.log(`🔍 OrgId: ${orgId}\n`);

  // Get all threads
  console.log(`📬 Loading threads from domain: ${DEMO_DOMAIN_NAME}`);
  const threads = await getThreadsForDomain(orgId);
  console.log(`✅ Found ${threads.length} threads to process\n`);

  if (threads.length === 0) {
    console.warn('⚠️  No threads found. Run the seed script first:');
    console.warn('   npx ts-node -r dotenv/config src/scripts/seed-sdr-demo.ts');
    process.exit(0);
  }

  // Process each thread
  let extracted = 0;
  let skipped = 0;
  let failed = 0;

  console.log('🤖 Processing threads with Azure OpenAI...\n');

  for (let i = 0; i < threads.length; i++) {
    const thread = threads[i];
    const prefix = `  [${String(i + 1).padStart(2, '0')}/${threads.length}]`;
    const label = thread.subject.length > 45 ? thread.subject.slice(0, 45) + '...' : thread.subject;

    process.stdout.write(`${prefix} ${label} ... `);

    if (!configured) {
      // Skip extraction but verify metadata exists
      console.log('(skipped — Azure not configured)');
      skipped++;
      continue;
    }

    const result = await extractGraphMetadata(thread);

    if (result) {
      await updateThreadMetadata(thread.thread_id, orgId, result);
      console.log(`✅ ${result.deal_stage} | ${result.company_name} | ${result.topics.slice(0, 3).join(', ')}`);
      extracted++;
    } else {
      console.log('❌ failed');
      failed++;
    }

    // Small delay to avoid rate limiting
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n✅ Extraction complete!`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📊 Results:`);
  console.log(`   Extracted:  ${extracted}`);
  console.log(`   Skipped:    ${skipped}`);
  console.log(`   Failed:     ${failed}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`\n🎯 Next step: run the graph API and view visualization`);
  console.log(`   GET /api/v1/graph?inbox_ids=inbox-alex-techflow,inbox-outreach-techflow,...`);

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
