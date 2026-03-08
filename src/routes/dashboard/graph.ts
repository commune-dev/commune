import { Router } from 'express';
import { getCollection } from '../../db';
import { decrypt } from '../../lib/encryption';
import { resolveOrgTier } from '../../lib/tierResolver';
import { hasFeature } from '../../config/rateLimits';
import logger from '../../utils/logger';

const router = Router();

// ─── Types ─────────────────────────────────────────────────────────────────

interface GraphNode {
  id: string;
  type: 'person' | 'company' | 'thread' | 'inbox' | 'phone_number' | 'phone_contact';
  label: string;
  channel?: 'email' | 'sms'; // discriminant for thread nodes

  // Person fields
  email?: string;
  company?: string;
  role?: string;
  sentiment?: string;
  messageCount?: number;
  lastActive?: string;
  isSDR?: boolean;

  // Company fields
  domain?: string;
  personCount?: number;
  threadCount?: number;
  dealHealth?: string;

  // Thread fields (shared email + SMS)
  subject?: string;
  snippet?: string;
  dealStage?: string;
  status?: string;
  topics?: string[];
  inboxId?: string;
  lastMessageAt?: string;
  firstMessageAt?: string;
  direction?: string;
  urgency?: string;
  summary?: string;
  nextAction?: string;

  // SMS thread fields
  remoteNumber?: string;        // E.164 of the external party in an SMS thread
  directionSummary?: 'inbound-only' | 'outbound-only' | 'bidirectional';

  // Inbox (email) fields
  address?: string;

  // Phone number (org-owned SMS number) fields
  number?: string;              // E.164
  capabilities?: { sms?: boolean; mms?: boolean; voice?: boolean };
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type:
    | 'participated'
    | 'cc_in'
    | 'works_at'
    | 'belongs_to'
    | 'reports_to'
    | 'works_with'
    | 'manages'
    | 'referred_to'
    | 'sms_participated'   // phone_contact → sms_thread
    | 'sms_belongs_to'     // sms_thread → phone_number
    | 'contacted_by_sms';  // phone_contact ↔ phone_number (aggregate)
  weight?: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function safeDecrypt(val: unknown): string {
  if (typeof val !== 'string') return '';
  try {
    return val.startsWith('enc:') ? decrypt(val) : val;
  } catch {
    return val;
  }
}

function domainFromEmail(email: string): string {
  const parts = email.split('@');
  return parts.length === 2 ? parts[1].toLowerCase() : email;
}

function companyNameFromDomain(domain: string): string {
  const known: Record<string, string> = {
    'stripe.com': 'Stripe',
    'notion.so': 'Notion',
    'linear.app': 'Linear',
    'retool.com': 'Retool',
    'figma.com': 'Figma',
    'vercel.com': 'Vercel',
    'rippling.com': 'Rippling',
    'lattice.com': 'Lattice',
    'front.com': 'Front',
    'brex.com': 'Brex',
    'attio.com': 'Attio',
    'hex.tech': 'Hex',
    'descript.com': 'Descript',
    'runwayml.com': 'Runway',
    'mercury.com': 'Mercury',
    'loom.com': 'Loom',
    'intercom.com': 'Intercom',
    'clearbit.com': 'Clearbit',
    'zendesk.com': 'Zendesk',
    'techflow.ai': 'TechFlow AI',
  };
  if (known[domain]) return known[domain];
  const name = domain.split('.')[0];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// ─── SMS graph builder ─────────────────────────────────────────────────────

async function buildSmsGraph(
  orgId: string,
  phoneNumberIds: string[],
  nodeMap: Map<string, GraphNode>,
  edgeMap: Map<string, GraphEdge>,
  addNode: (node: GraphNode) => void,
  addEdge: (edge: Omit<GraphEdge, 'id'>) => void
): Promise<{ messageCount: number }> {
  const messagesCol = await getCollection('messages');
  const phoneNumbersCol = await getCollection('phone_numbers');
  if (!messagesCol || !phoneNumbersCol) return { messageCount: 0 };

  // 1. Fetch org's phone number documents → phone_number nodes
  const phoneNumberDocs = await phoneNumbersCol
    .find({ orgId, id: { $in: phoneNumberIds } })
    .toArray() as Array<Record<string, unknown>>;

  for (const pn of phoneNumberDocs) {
    addNode({
      id: `phone_number:${pn.id}`,
      type: 'phone_number',
      label: String(pn.friendlyName || pn.number || pn.id),
      number: String(pn.number || ''),
      capabilities: pn.capabilities as any,
      messageCount: 0,
      lastActive: undefined,
    });
  }

  // 2. Fetch SMS messages for these phone numbers
  const rawSmsMessages = await messagesCol
    .find({
      orgId,
      channel: 'sms',
      'metadata.phone_number_id': { $in: phoneNumberIds },
    })
    .sort({ created_at: 1 })
    .limit(1000)
    .toArray() as Array<Record<string, unknown>>;

  if (rawSmsMessages.length === 0) return { messageCount: 0 };

  // 3. Group by thread_id
  const smsThreadMessages = new Map<string, Array<Record<string, unknown>>>();
  for (const msg of rawSmsMessages) {
    const tid = String(msg.thread_id || msg.message_id || '');
    if (!smsThreadMessages.has(tid)) smsThreadMessages.set(tid, []);
    smsThreadMessages.get(tid)!.push(msg);
  }

  // 4. Build thread nodes, phone_contact nodes, and edges
  for (const [threadId, msgs] of smsThreadMessages.entries()) {
    const first = msgs[0];
    const last = msgs[msgs.length - 1];
    const meta = (first.metadata as Record<string, unknown>) || {};

    const phoneNumberId = String(meta.phone_number_id || '');
    const fromNumber = String(meta.from_number || '');
    const toNumber = String(meta.to_number || '');
    const firstDir = String(first.direction || 'inbound');

    // The remote number is whoever is NOT the org's own phone number
    const remoteNumber = firstDir === 'inbound' ? fromNumber : toNumber;

    // Compute direction summary across all messages in thread
    const directions = new Set(msgs.map(m => String(m.direction)));
    const dirSummary: 'inbound-only' | 'outbound-only' | 'bidirectional' =
      directions.size > 1 ? 'bidirectional'
      : directions.has('inbound') ? 'inbound-only'
      : 'outbound-only';

    const snippet = String(first.content || '').slice(0, 120);

    // SMS thread node
    addNode({
      id: `thread:${threadId}`,
      type: 'thread',
      channel: 'sms',
      label: `SMS with ${remoteNumber}`,
      subject: `SMS with ${remoteNumber}`,
      snippet,
      status: 'open',
      topics: [],
      inboxId: phoneNumberId,
      messageCount: msgs.length,
      lastMessageAt: String(last.created_at || ''),
      firstMessageAt: String(first.created_at || ''),
      direction: firstDir,
      directionSummary: dirSummary,
      remoteNumber,
    });

    // sms_thread → phone_number
    addEdge({
      source: `thread:${threadId}`,
      target: `phone_number:${phoneNumberId}`,
      type: 'sms_belongs_to',
    });

    // Update phone_number node message count and lastActive
    const phoneNode = nodeMap.get(`phone_number:${phoneNumberId}`);
    if (phoneNode) {
      phoneNode.messageCount = (phoneNode.messageCount || 0) + msgs.length;
      const lastAt = String(last.created_at || '');
      if (!phoneNode.lastActive || lastAt > phoneNode.lastActive) {
        phoneNode.lastActive = lastAt;
      }
    }

    // phone_contact node — keyed by E.164 remote number
    const contactKey = `phone_contact:${remoteNumber}`;
    addNode({
      id: contactKey,
      type: 'phone_contact',
      label: remoteNumber,
      number: remoteNumber,
      messageCount: msgs.length,
      lastActive: String(last.created_at || ''),
      directionSummary: dirSummary,
    });

    // phone_contact → sms_thread
    addEdge({
      source: contactKey,
      target: `thread:${threadId}`,
      type: 'sms_participated',
    });

    // phone_contact ↔ phone_number (aggregate relationship)
    addEdge({
      source: contactKey,
      target: `phone_number:${phoneNumberId}`,
      type: 'contacted_by_sms',
    });
  }

  return { messageCount: rawSmsMessages.length };
}

// ─── GET /api/graph ────────────────────────────────────────────────────────
//
// Query params:
//   inbox_ids        - Comma-separated email inbox IDs (for email subgraph)
//   phone_number_ids - Comma-separated phone number IDs (for SMS subgraph)
//
// At least one of inbox_ids or phone_number_ids is required.
//
// Email and SMS nodes are returned together in a single response.
// They form separate visual clusters (email: person/company/thread/inbox;
// SMS: phone_contact/phone_number/thread[channel=sms]).
// Company nodes can be shared when the same domain appears in both channels.

router.get('/graph', async (req, res) => {
  const orgId = (req as any).apiKey?.orgId || null;
  if (!orgId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const orgTier = await resolveOrgTier(orgId);
  if (!hasFeature(orgTier, 'networkGraph')) {
    return res.status(403).json({ error: 'plan_upgrade_required' });
  }

  const inboxIdsRaw = req.query.inbox_ids as string || '';
  const phoneNumberIdsRaw = req.query.phone_number_ids as string || '';

  const inboxIds = inboxIdsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  const phoneNumberIds = phoneNumberIdsRaw.split(',').map((s) => s.trim()).filter(Boolean);

  if (inboxIds.length === 0 && phoneNumberIds.length === 0) {
    return res.status(400).json({ error: 'inbox_ids or phone_number_ids query parameter is required' });
  }

  try {
    const messagesCol = await getCollection('messages');
    const threadMetaCol = await getCollection('thread_metadata');

    if (!messagesCol) {
      return res.status(503).json({ error: 'Database unavailable' });
    }

    // ── Shared node/edge map (email and SMS share the same map) ─────

    const nodeMap = new Map<string, GraphNode>();
    const edgeMap = new Map<string, GraphEdge>();

    const addNode = (node: GraphNode) => {
      const existing = nodeMap.get(node.id);
      if (!existing) {
        nodeMap.set(node.id, node);
      } else {
        // Merge counts
        if (node.messageCount) existing.messageCount = (existing.messageCount || 0) + node.messageCount;
        if (node.personCount) existing.personCount = (existing.personCount || 0) + node.personCount;
        if (node.threadCount) existing.threadCount = (existing.threadCount || 0) + node.threadCount;
        if (node.lastActive && (!existing.lastActive || node.lastActive > existing.lastActive)) {
          existing.lastActive = node.lastActive;
        }
      }
    };

    const addEdge = (edge: Omit<GraphEdge, 'id'>) => {
      const edgeId = `${edge.source}→${edge.target}:${edge.type}`;
      if (!edgeMap.has(edgeId)) {
        edgeMap.set(edgeId, { ...edge, id: edgeId, weight: 1 });
      } else {
        edgeMap.get(edgeId)!.weight = (edgeMap.get(edgeId)!.weight || 1) + 1;
      }
    };

    // ── Email subgraph ───────────────────────────────────────────────

    let emailMessageCount = 0;

    if (inboxIds.length > 0) {
      const rawMessages = await messagesCol
        .find({
          orgId,
          channel: { $ne: 'sms' },   // include 'email' and legacy docs without channel field
          'metadata.inbox_id': { $in: inboxIds },
        })
        .sort({ created_at: 1 })
        .limit(1000)
        .toArray() as Array<Record<string, unknown>>;

      emailMessageCount = rawMessages.length;

      // Fetch thread metadata (for extracted_data)
      const threadIds = [...new Set(rawMessages.map((m) => String(m.thread_id || m.message_id || '')))];
      const threadMetaDocs: Record<string, Record<string, unknown>> = {};

      if (threadMetaCol && threadIds.length > 0) {
        const metas = await threadMetaCol
          .find({ orgId, thread_id: { $in: threadIds } })
          .toArray() as Array<Record<string, unknown>>;
        for (const meta of metas) {
          threadMetaDocs[String(meta.thread_id)] = meta;
        }
      }

      // Build the set of email addresses that belong to the user's own inboxes
      const ownAddresses = new Set<string>();
      const inboxAddressMap = new Map<string, string>();

      for (const inboxId of inboxIds) {
        const sample = rawMessages.find((m) => {
          const meta = m.metadata as Record<string, unknown> || {};
          return String(meta.inbox_id) === inboxId;
        });
        const address = sample
          ? safeDecrypt((sample.metadata as Record<string, unknown>)?.inbox_address as unknown) || inboxId
          : inboxId;
        const addressLower = address.toLowerCase().trim();
        ownAddresses.add(addressLower);
        inboxAddressMap.set(inboxId, address);

        addNode({
          id: `inbox:${inboxId}`,
          type: 'inbox',
          label: address,
          address,
          threadCount: 0,
        });
      }

      // Group by thread
      const threadMessages = new Map<string, Array<Record<string, unknown>>>();
      for (const msg of rawMessages) {
        const tid = String(msg.thread_id || msg.message_id || '');
        if (!threadMessages.has(tid)) threadMessages.set(tid, []);
        threadMessages.get(tid)!.push(msg);
      }

      for (const [threadId, msgs] of threadMessages.entries()) {
        const first = msgs[0];
        const last = msgs[msgs.length - 1];
        const meta = first.metadata as Record<string, unknown> || {};
        const inboxId = String(meta.inbox_id || '');
        const threadMeta = threadMetaDocs[threadId] || {};
        const extracted = threadMeta.extracted_data as Record<string, unknown> || {};

        const rawSubject = safeDecrypt(meta.subject as unknown);
        const subject = rawSubject || '(no subject)';
        const snippet = safeDecrypt(String(first.content || '')).slice(0, 120);

        const threadStatus = String(extracted.thread_status || extracted.deal_stage || 'active');
        const threadCategory = String(extracted.thread_category || '');
        const urgency = String(extracted.urgency || 'medium');
        const summary = String(extracted.summary || '');
        const nextAction = String(extracted.next_action || '');

        addNode({
          id: `thread:${threadId}`,
          type: 'thread',
          channel: 'email',
          label: subject,
          subject,
          snippet: summary || snippet,
          dealStage: threadStatus,
          status: threadCategory || String(threadMeta.status || 'open'),
          topics: (extracted.topics as string[]) || [],
          inboxId,
          messageCount: msgs.length,
          lastMessageAt: String(last.created_at || ''),
          firstMessageAt: String(first.created_at || ''),
          direction: String(first.direction || ''),
          urgency,
          summary,
          nextAction,
        });

        addEdge({ source: `thread:${threadId}`, target: `inbox:${inboxId}`, type: 'belongs_to' });

        const inboxNode = nodeMap.get(`inbox:${inboxId}`);
        if (inboxNode) inboxNode.threadCount = (inboxNode.threadCount || 0) + 1;

        const keyContacts = (extracted.key_contacts as Array<{
          email: string; name: string; role: string; sentiment: string; organization?: string;
        }>) || [];
        const contactNameMap = new Map<string, { name: string; role: string; sentiment: string; organization: string }>();
        for (const kc of keyContacts) {
          if (kc.email) {
            contactNameMap.set(kc.email.toLowerCase().trim(), {
              name: kc.name || '',
              role: kc.role || '',
              sentiment: kc.sentiment || 'neutral',
              organization: kc.organization || '',
            });
          }
        }

        const participantEmails = new Set<string>();

        for (const msg of msgs) {
          const participants = (msg.participants as Array<{ role: string; identity: string }>) || [];
          for (const p of participants) {
            const email = safeDecrypt(p.identity || '').toLowerCase().trim();
            if (!email || email.length < 4) continue;

            const emailDomain = domainFromEmail(email);
            const contactInfo = contactNameMap.get(email);

            const companyName = contactInfo?.organization && contactInfo.organization.trim()
              ? contactInfo.organization
              : companyNameFromDomain(emailDomain);

            const isOwnInbox = ownAddresses.has(email);
            const nameFromEmail = email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
            const label = contactInfo?.name && contactInfo.name.trim() ? contactInfo.name : nameFromEmail;

            addNode({
              id: `person:${email}`,
              type: 'person',
              label,
              email,
              company: companyName,
              role: contactInfo?.role || '',
              sentiment: contactInfo?.sentiment || '',
              messageCount: 1,
              lastActive: String(msg.created_at || ''),
              isSDR: isOwnInbox,
            });

            if (!isOwnInbox) {
              addNode({
                id: `company:${emailDomain}`,
                type: 'company',
                label: companyName,
                domain: emailDomain,
                personCount: 0,
                threadCount: 0,
                dealHealth: urgency === 'high' ? 'hot' : urgency === 'medium' ? 'warm' : 'cold',
              });

              addEdge({ source: `person:${email}`, target: `company:${emailDomain}`, type: 'works_at' });

              const companyNode = nodeMap.get(`company:${emailDomain}`);
              if (companyNode && !participantEmails.has(email)) {
                companyNode.personCount = (companyNode.personCount || 0) + 1;
              }
            }

            const edgeType = p.role === 'cc' ? 'cc_in' : 'participated';
            addEdge({ source: `person:${email}`, target: `thread:${threadId}`, type: edgeType });
            participantEmails.add(email);
          }
        }

        const companiesInThread = new Set<string>();
        for (const email of participantEmails) {
          const domain = domainFromEmail(email);
          if (!ownAddresses.has(email)) companiesInThread.add(domain);
        }
        for (const comp of companiesInThread) {
          const companyNode = nodeMap.get(`company:${comp}`);
          if (companyNode) companyNode.threadCount = (companyNode.threadCount || 0) + 1;
        }

        const relationships = (extracted.relationships as Array<{ from: string; to: string; type: string }>) || [];
        for (const rel of relationships) {
          if (rel.from && rel.to && rel.type) {
            const fromEmail = rel.from.toLowerCase().trim();
            const toEmail = rel.to.toLowerCase().trim();
            if (fromEmail !== toEmail && fromEmail.includes('@') && toEmail.includes('@')) {
              addEdge({
                source: `person:${fromEmail}`,
                target: `person:${toEmail}`,
                type: rel.type as GraphEdge['type'],
              });
            }
          }
        }
      }
    }

    // ── SMS subgraph ─────────────────────────────────────────────────

    let smsMessageCount = 0;

    if (phoneNumberIds.length > 0) {
      const { messageCount } = await buildSmsGraph(
        orgId,
        phoneNumberIds,
        nodeMap,
        edgeMap,
        addNode,
        addEdge
      );
      smsMessageCount = messageCount;
    }

    // ── Build final response ─────────────────────────────────────────

    const nodes = Array.from(nodeMap.values());
    const edges = Array.from(edgeMap.values());

    const personCount = nodes.filter((n) => n.type === 'person' && !n.isSDR).length;
    const companyCount = nodes.filter((n) => n.type === 'company').length;
    const emailThreadCount = nodes.filter((n) => n.type === 'thread' && n.channel === 'email').length;
    const smsThreadCount = nodes.filter((n) => n.type === 'thread' && n.channel === 'sms').length;
    const phoneContactCount = nodes.filter((n) => n.type === 'phone_contact').length;
    const phoneNumberCount = nodes.filter((n) => n.type === 'phone_number').length;

    logger.info('Graph data built', {
      orgId, inboxIds, phoneNumberIds,
      nodes: nodes.length, edges: edges.length,
    });

    return res.json({
      nodes,
      edges,
      stats: {
        totalMessages: emailMessageCount + smsMessageCount,
        emailMessages: emailMessageCount,
        smsMessages: smsMessageCount,
        totalContacts: personCount,
        totalCompanies: companyCount,
        totalThreads: emailThreadCount,
        totalInboxes: inboxIds.length,
        smsThreads: smsThreadCount,
        phoneContacts: phoneContactCount,
        phoneNumbers: phoneNumberCount,
      },
    });
  } catch (err) {
    logger.error('Graph API error', { error: err instanceof Error ? err.message : err });
    return res.status(500).json({ error: 'Failed to build graph data' });
  }
});

export default router;
