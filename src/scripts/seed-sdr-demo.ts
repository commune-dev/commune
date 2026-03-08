/**
 * SDR Demo Seeding Script
 * Creates 5 inboxes + ~260 realistic SDR email conversations for graph visualization demo.
 *
 * Run: cd backend && npx ts-node -r dotenv/config src/scripts/seed-sdr-demo.ts
 */

import { randomUUID } from 'crypto';
import { connect, getCollection } from '../db';
import messageStore from '../stores/messageStore';
import domainStore from '../stores/domainStore';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEMO_DOMAIN_NAME = 'techflow.ai';
const DEMO_DOMAIN_ID = 'demo-domain-techflow-ai';
const SDR_NAME = 'Alex Chen';

// Inbox definitions
const INBOXES = [
  { localPart: 'alex', id: 'inbox-alex-techflow', label: 'Main SDR' },
  { localPart: 'outreach', id: 'inbox-outreach-techflow', label: 'Cold Outreach' },
  { localPart: 'enterprise', id: 'inbox-enterprise-techflow', label: 'Enterprise' },
  { localPart: 'demos', id: 'inbox-demos-techflow', label: 'Demo Bookings' },
  { localPart: 'partnerships', id: 'inbox-partnerships-techflow', label: 'Partnerships' },
];

// Email addresses
const SDR = {
  alex: `alex@${DEMO_DOMAIN_NAME}`,
  outreach: `outreach@${DEMO_DOMAIN_NAME}`,
  enterprise: `enterprise@${DEMO_DOMAIN_NAME}`,
  demos: `demos@${DEMO_DOMAIN_NAME}`,
  partnerships: `partnerships@${DEMO_DOMAIN_NAME}`,
};

// Prospect contacts
const CONTACTS = {
  // Stripe
  sarah_stripe: 'sarah.chen@stripe.com',
  mike_stripe: 'mike.johnson@stripe.com',
  diana_stripe: 'diana.park@stripe.com',
  // Notion
  emma_notion: 'emma.rodriguez@notion.so',
  james_notion: 'james.wu@notion.so',
  // Linear
  josh_linear: 'josh.miller@linear.app',
  // Retool
  priya_retool: 'priya.patel@retool.com',
  tom_retool: 'tom.anderson@retool.com',
  lisa_retool: 'lisa.kim@retool.com',
  // Figma
  david_figma: 'david.lee@figma.com',
  anna_figma: 'anna.white@figma.com',
  // Vercel
  sam_vercel: 'sam.nguyen@vercel.com',
  // Rippling
  chris_rippling: 'chris.evans@rippling.com',
  jennifer_rippling: 'jennifer.liu@rippling.com',
  // Lattice
  maya_lattice: 'maya.brown@lattice.com',
  kevin_lattice: 'kevin.zhang@lattice.com',
  // Front
  ryan_front: 'ryan.carter@front.com',
  // Brex
  alex_brex: 'alex.kim@brex.com',
  rachel_brex: 'rachel.hong@brex.com',
  // Attio
  oliver_attio: 'oliver.jones@attio.com',
  // Hex
  zoe_hex: 'zoe.taylor@hex.tech',
  // Descript
  noah_descript: 'noah.wilson@descript.com',
  // Runway
  sophia_runway: 'sophia.garcia@runwayml.com',
  // Mercury
  william_mercury: 'william.chen@mercury.com',
  grace_mercury: 'grace.liu@mercury.com',
  henry_mercury: 'henry.park@mercury.com',
  // Loom
  claire_loom: 'claire.davidson@loom.com',
  marcus_loom: 'marcus.lee@loom.com',
  // Attio legal
  legal_attio: 'legal@attio.com',
  procurement_retool: 'procurement@retool.com',
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface MessageDef {
  from: string;
  to: string[];
  cc?: string[];
  body: string;
  daysAgo: number;
  hoursOffset?: number;
}

interface ThreadDef {
  subject: string;
  inboxId: string;
  inboxAddress: string;
  domainId: string;
  orgId: string;
  messages: MessageDef[];
  status?: 'open' | 'needs_reply' | 'waiting' | 'closed';
  tags?: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function daysAgo(days: number, hoursOffset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(d.getHours() - hoursOffset);
  return d.toISOString();
}

async function insertThread(thread: ThreadDef): Promise<{ threadId: string; messageCount: number }> {
  const threadId = randomUUID();
  let prevMessageId: string | null = null;
  const references: string[] = [];

  for (let i = 0; i < thread.messages.length; i++) {
    const msg = thread.messages[i];
    const messageId = randomUUID();
    const createdAt = daysAgo(msg.daysAgo, msg.hoursOffset || 0);

    const participants = [
      { role: 'sender' as const, identity: msg.from },
      ...msg.to.map((t) => ({ role: 'to' as const, identity: t })),
      ...(msg.cc || []).map((c) => ({ role: 'cc' as const, identity: c })),
    ];

    await messageStore.insertMessage({
      channel: 'email',
      message_id: messageId,
      thread_id: threadId,
      direction: msg.from.endsWith(DEMO_DOMAIN_NAME) ? 'outbound' : 'inbound',
      participants,
      content: msg.body,
      content_html: `<div style="font-family: sans-serif; font-size: 14px;">${msg.body.replace(/\n/g, '<br/>')}</div>`,
      attachments: [],
      created_at: createdAt,
      orgId: thread.orgId,
      metadata: {
        created_at: createdAt,
        subject: i === 0 ? thread.subject : `Re: ${thread.subject}`,
        in_reply_to: prevMessageId ? `<${prevMessageId}@${DEMO_DOMAIN_NAME}>` : null,
        references: [...references],
        inbox_id: thread.inboxId,
        inbox_address: thread.inboxAddress,
        domain_id: thread.domainId,
        message_id: `<${messageId}@${DEMO_DOMAIN_NAME}>`,
        delivery_status: 'delivered',
        delivery_data: {
          sent_at: createdAt,
          delivered_at: new Date(new Date(createdAt).getTime() + 30000).toISOString(),
        },
      },
    });

    references.push(`<${messageId}@${DEMO_DOMAIN_NAME}>`);
    prevMessageId = messageId;
  }

  return { threadId, messageCount: thread.messages.length };
}

async function upsertThreadMetadata(
  threadId: string,
  orgId: string,
  status: 'open' | 'needs_reply' | 'waiting' | 'closed',
  tags: string[],
  extractedData: Record<string, unknown>,
) {
  const col = await getCollection('thread_metadata');
  if (!col) return;
  await col.updateOne(
    { thread_id: threadId, orgId },
    {
      $set: {
        status,
        tags,
        extracted_data: extractedData,
        updated_at: new Date().toISOString(),
      },
      $setOnInsert: {
        thread_id: threadId,
        orgId,
      },
    },
    { upsert: true },
  );
}

// ─── Thread Definitions ───────────────────────────────────────────────────────

function buildThreads(orgId: string): ThreadDef[] {
  const inboxes = {
    alex: { id: INBOXES[0].id, address: SDR.alex },
    outreach: { id: INBOXES[1].id, address: SDR.outreach },
    enterprise: { id: INBOXES[2].id, address: SDR.enterprise },
    demos: { id: INBOXES[3].id, address: SDR.demos },
    partnerships: { id: INBOXES[4].id, address: SDR.partnerships },
  };

  const T = (
    subject: string,
    inbox: { id: string; address: string },
    messages: MessageDef[],
    status: 'open' | 'needs_reply' | 'waiting' | 'closed' = 'open',
    tags: string[] = [],
  ): ThreadDef => ({
    subject,
    inboxId: inbox.id,
    inboxAddress: inbox.address,
    domainId: DEMO_DOMAIN_ID,
    orgId,
    messages,
    status,
    tags,
  });

  return [
    // ─── INBOX 1: alex@techflow.ai — Main SDR inbox ─────────────────────────

    // Thread 1: Stripe - Long warm thread (12 messages), negotiating
    T(
      'Scaling Stripe\'s outbound without adding headcount',
      inboxes.alex,
      [
        {
          from: SDR.alex,
          to: [CONTACTS.sarah_stripe],
          body: `Hi Sarah,\n\nI came across your LinkedIn post last week about building out Stripe's enterprise sales motion — really resonated with what you wrote about the challenge of scaling outbound quality while headcount stays flat.\n\nAt TechFlow AI, we help VP Sales leaders at companies like Stripe automate high-quality outreach sequences using AI that actually writes in your reps' voice — not generic templates. Teams using us typically see 3x more qualified meetings booked with the same SDR headcount.\n\nWould it be worth a 20-minute conversation this week to see if there's a fit? I have Thursday 2pm or Friday 10am PT open.\n\nBest,\nAlex\nTechFlow AI`,
          daysAgo: 42,
        },
        {
          from: CONTACTS.sarah_stripe,
          to: [SDR.alex],
          body: `Hi Alex,\n\nGood timing on this — we just kicked off a Q2 planning session and pipeline generation is top of mind.\n\nI'm curious how the AI voice-matching actually works in practice. Our reps all have very different styles, and we've burned ourselves before with tools that make everyone sound like a robot.\n\nThursday 2pm works. Send me a calendar invite.\n\nSarah`,
          daysAgo: 41,
        },
        {
          from: SDR.alex,
          to: [CONTACTS.sarah_stripe],
          body: `Sarah,\n\nPerfect — invite sent for Thursday. Here's the quick version of how the voice-matching works:\n\nWe analyze each rep's existing sent emails (with permission) and build a style profile — sentence length, tone, vocabulary, how they structure CTAs. Then when generating outreach, the AI uses that profile as a constraint, not just a style guide. Reps review everything before it sends, so they stay in control.\n\nWe also learn from which emails actually get replies — so the system compounds over time.\n\nSee you Thursday.\n\nAlex`,
          daysAgo: 41,
          hoursOffset: -3,
        },
        {
          from: CONTACTS.sarah_stripe,
          to: [SDR.alex],
          cc: [CONTACTS.mike_stripe],
          body: `Alex,\n\nAfter our call — genuinely impressed. Going to bring Mike from RevOps into this conversation since he'd own the integration piece. He's CC'd here.\n\nMike, Alex and team have a genuinely different approach to AI outreach. Worth 30 mins of your time.\n\nSarah`,
          daysAgo: 38,
        },
        {
          from: SDR.alex,
          to: [CONTACTS.sarah_stripe, CONTACTS.mike_stripe],
          cc: [],
          body: `Mike, great to be introduced — and Sarah, thank you.\n\nMike, based on what Sarah shared about your current stack (Salesforce + Outreach), our setup is pretty lightweight — a Salesforce managed package for data sync and an Outreach integration for sequence management. Most RevOps teams are live within a week.\n\nI can send over our integration docs or hop on a technical call, whichever is more useful. What does your current sequencing workflow look like?\n\nAlex`,
          daysAgo: 37,
        },
        {
          from: CONTACTS.mike_stripe,
          to: [SDR.alex],
          cc: [CONTACTS.sarah_stripe],
          body: `Hey Alex,\n\nAppreciate the context. Our main concern is around data residency — we have some enterprise customer contracts that restrict where prospect data can be stored. Can you send over your SOC 2 report and data processing agreement?\n\nAlso curious: do you have any customers in fintech/payments where there are similar compliance requirements?\n\nMike`,
          daysAgo: 36,
        },
        {
          from: SDR.alex,
          to: [CONTACTS.mike_stripe, CONTACTS.sarah_stripe],
          body: `Mike,\n\nAbsolutely — sending both over right now.\n\n- SOC 2 Type II report (current, renewed Jan 2026): attached\n- DPA with GDPR, CCPA, and SCCs: attached\n\nOn fintech customers: yes — Brex and Mercury are both active customers. Mercury specifically had similar enterprise data residency requirements and we worked through an EU data processing addendum with their legal team. Happy to connect you with their CRO as a reference.\n\nWe also offer a private cloud deployment option if full data isolation is a hard requirement.\n\nLet me know what other questions come up.\n\nAlex`,
          daysAgo: 35,
        },
        {
          from: CONTACTS.mike_stripe,
          to: [SDR.alex],
          cc: [CONTACTS.sarah_stripe, CONTACTS.diana_stripe],
          body: `Alex,\n\nI've reviewed the DPA — looks solid. I'm pulling Diana (our CRO) into this thread because she's the final decision-maker on new sales tools.\n\nDiana, TechFlow AI is the AI outreach tool Sarah and I have been evaluating. Strong compliance posture, good reference in Mercury. I'd recommend moving to a pilot.\n\nSarah — what's our timeline for Q2 pipeline goals?\n\nMike`,
          daysAgo: 30,
        },
        {
          from: CONTACTS.diana_stripe,
          to: [SDR.alex, CONTACTS.mike_stripe, CONTACTS.sarah_stripe],
          body: `Alex,\n\nGood to meet you (digitally). Mike's recommendation carries weight here.\n\nTwo questions before I greenlight a pilot:\n1. What does a typical 90-day pilot look like and how do you measure success?\n2. What's the pricing model — per seat, per sequence, or usage-based?\n\nDiana`,
          daysAgo: 29,
        },
        {
          from: SDR.alex,
          to: [CONTACTS.diana_stripe, CONTACTS.mike_stripe, CONTACTS.sarah_stripe],
          body: `Diana,\n\nGreat questions — here's the framework we use for pilots:\n\n**90-day pilot structure:**\n- Weeks 1-2: Onboarding, style profile setup, CRM integration\n- Weeks 3-6: First live sequences (typically 200-400 prospects)\n- Weeks 7-12: Optimization based on reply rates, A/B testing messaging\n\n**Success metrics we track:**\n- Reply rate vs. your current baseline\n- Meetings booked per SDR per week\n- Time saved per rep on manual outreach\n\nMost pilots hit 2-3x meeting volume by week 8. We guarantee it in writing.\n\n**Pricing:** Seat-based with a usage floor. For a team your size (assuming ~8 SDRs?), we're typically $4,800/month including unlimited sequences. Happy to send a formal proposal.\n\nAlex`,
          daysAgo: 28,
        },
        {
          from: CONTACTS.diana_stripe,
          to: [SDR.alex],
          cc: [CONTACTS.mike_stripe, CONTACTS.sarah_stripe],
          body: `Alex,\n\nThe pilot structure makes sense. The guaranteed meeting volume metric is what I needed to see.\n\nI need our procurement team to review the contract terms before we sign anything. Can you send the standard MSA? We'll redline and come back to you.\n\nTarget start date: March 1. That gives us 4 weeks to close the paperwork.\n\nDiana`,
          daysAgo: 21,
        },
        {
          from: SDR.alex,
          to: [CONTACTS.diana_stripe, CONTACTS.mike_stripe, CONTACTS.sarah_stripe],
          body: `Diana,\n\nMSA sent to your email directly (in a separate thread with our legal contact copied).\n\nI'll mark March 1 as the target. To hit that, we'd need signed docs by February 21 — that gives our implementation team 7 days for setup.\n\nI'll set a check-in for February 14 to see where procurement stands. Looking forward to getting Stripe's team live!\n\nAlex`,
          daysAgo: 20,
        },
      ],
      'needs_reply',
      ['enterprise', 'negotiating', 'hot'],
    ),

    // Thread 2: Notion - Won thread, 5 messages
    T(
      'Quick question about your SDR stack',
      inboxes.alex,
      [
        {
          from: SDR.alex,
          to: [CONTACTS.emma_notion],
          body: `Hi Emma,\n\nI noticed Notion has been expanding its sales team significantly over the past year — congrats on the growth.\n\nI work with a few other Head of Sales leaders at PLG companies who are navigating the same challenge: how do you add enterprise outbound without losing the product-led feel that made you successful?\n\nTechFlow AI helps PLG companies run targeted, personalized outbound that complements self-serve — not the spray-and-pray approach. Asana and Figma use us for exactly this.\n\nWorth a 15-minute call? I have slots this Thursday afternoon.\n\nAlex`,
          daysAgo: 55,
        },
        {
          from: CONTACTS.emma_notion,
          to: [SDR.alex],
          body: `Alex,\n\nYes — this is very timely. We've been debating this exact tension in leadership meetings. The concern is always that aggressive outbound feels off-brand for Notion.\n\nThursday 3pm PT works. Send the invite.\n\nEmma`,
          daysAgo: 54,
        },
        {
          from: SDR.alex,
          to: [CONTACTS.emma_notion],
          body: `Emma,\n\nInvite sent. One thing to send ahead of time: we have a Figma-specific case study on how they approached outbound as a PLG company — increased enterprise pipeline by 4x without changing brand voice. Sending it here in case you want to share with your team before Thursday.\n\n[Case Study: Figma Outbound Playbook — TechFlow AI]\n\nSee you Thursday.\n\nAlex`,
          daysAgo: 54,
          hoursOffset: -2,
        },
        {
          from: CONTACTS.emma_notion,
          to: [SDR.alex],
          cc: [CONTACTS.james_notion],
          body: `Alex,\n\nWe talked — this is exactly what we're looking for. Looping in James (SDR Manager) who would own this day-to-day.\n\nJames: TechFlow AI is the outreach automation tool I mentioned. Alex can do a technical walkthrough whenever works for you.\n\nAlex — can you send pricing for a team of 6 SDRs?\n\nEmma`,
          daysAgo: 50,
        },
        {
          from: SDR.alex,
          to: [CONTACTS.emma_notion, CONTACTS.james_notion],
          body: `Emma, James,\n\nGreat to include James — he'll love the workflow integrations.\n\nFor 6 SDRs: $2,900/month (annual) or $3,400/month (monthly), with unlimited sequences and full Salesforce + HubSpot integration.\n\nJames — booking a 30-minute technical walkthrough with you directly. I'll send a Calendly link.\n\nLooking forward to getting Notion's outbound engine running!\n\nAlex`,
          daysAgo: 49,
        },
      ],
      'closed',
      ['closed-won', 'plg', 'reference-customer'],
    ),

    // Thread 3: Linear - Cold, no reply (2 messages)
    T(
      'SDR efficiency at Linear — quick thought',
      inboxes.alex,
      [
        {
          from: SDR.alex,
          to: [CONTACTS.josh_linear],
          body: `Hi Josh,\n\nI've been following Linear's growth trajectory and noticed you've been scaling the sales team alongside a strong product-led base.\n\nAt TechFlow AI, we help SDR Managers like you automate the repetitive parts of outreach — research, personalization, sequence management — so your reps spend time on conversations, not copy-pasting.\n\nWould it make sense to spend 20 minutes comparing notes on how your team is currently handling outbound?\n\nAlex Chen\nTechFlow AI`,
          daysAgo: 30,
        },
        {
          from: SDR.alex,
          to: [CONTACTS.josh_linear],
          body: `Hi Josh,\n\nFollowing up on my note from last week — I know your inbox is busy.\n\nOne specific thing I wanted to share: we just published a benchmark report on SDR productivity at developer-focused SaaS companies (15 companies, 200+ reps). The median team using TechFlow AI books 2.7x more meetings per rep than industry average.\n\nHappy to send the report — no strings attached. Would that be useful?\n\nAlex`,
          daysAgo: 23,
        },
      ],
      'open',
      ['cold', 'no-reply'],
    ),

    // Thread 4: Rippling - Multi-stakeholder, active (7 messages)
    T(
      'AI outreach for Rippling\'s enterprise sales team',
      inboxes.alex,
      [
        {
          from: SDR.alex,
          to: [CONTACTS.chris_rippling],
          body: `Hi Chris,\n\nI know Rippling's sales motion is sophisticated — you're selling a complex platform to CFOs and CHROs simultaneously. That takes reps who can multi-thread deals, not just send cold emails.\n\nTechFlow AI helps VP Sales leaders like you automate the top-of-funnel so your best reps can focus on the complex, multi-threaded deals you're known for.\n\nI'd love to show you what we're doing for a few other companies at Rippling's stage. 20 minutes this week?\n\nAlex`,
          daysAgo: 35,
        },
        {
          from: CONTACTS.chris_rippling,
          to: [SDR.alex],
          body: `Alex,\n\nAppreciate the specific framing around multi-threading — that is exactly our reality. We have enterprise reps managing 6-8 stakeholders per deal simultaneously.\n\nThe question for us isn't whether to automate top-of-funnel — we already do some of this. The question is whether your AI can handle the complexity of our target personas (HR leaders + Finance leaders at the same company).\n\nCan you do Monday 4pm PT?\n\nChris`,
          daysAgo: 34,
        },
        {
          from: SDR.alex,
          to: [CONTACTS.chris_rippling],
          body: `Chris,\n\nMonday 4pm works — invite sent.\n\nTo preview the answer on multi-persona: yes, this is something we handle specifically. You can set up different sequence tracks by persona type (CHRO vs CFO), with different messaging, different CTAs, and different follow-up cadences. And when a prospect from Track A replies and mentions their CFO, the system flags it for multi-thread follow-up.\n\nLooking forward to Monday.\n\nAlex`,
          daysAgo: 34,
          hoursOffset: -2,
        },
        {
          from: CONTACTS.chris_rippling,
          to: [SDR.alex],
          cc: [CONTACTS.jennifer_rippling],
          body: `Alex,\n\nOur call was helpful. I want to bring in Jennifer (Head of RevOps) because she owns our outreach stack.\n\nJen — TechFlow AI does AI-powered sequencing with persona-based multi-track capability. Could solve the CHRO/CFO problem we've been discussing. Can you find 30 min with Alex this week?\n\nChris`,
          daysAgo: 30,
        },
        {
          from: CONTACTS.jennifer_rippling,
          to: [SDR.alex, CONTACTS.chris_rippling],
          body: `Alex,\n\nHi — Jennifer here. A few hard requirements on our end before I can evaluate:\n\n1. Salesforce native or deep API integration (we're very Salesforce-heavy)\n2. Respect existing suppression lists / DNC lists\n3. Outreach.io compatibility (we use it as our sequencing layer)\n\nCan you confirm these and ideally walk me through the integration architecture?\n\nJennifer`,
          daysAgo: 29,
        },
        {
          from: SDR.alex,
          to: [CONTACTS.jennifer_rippling, CONTACTS.chris_rippling],
          body: `Jennifer,\n\nHitting all three:\n\n1. **Salesforce:** Native managed package — bi-directional sync, not API polling. Contacts, activities, and custom fields all sync in real-time.\n\n2. **Suppression lists:** First thing we configure. We pull your DNC list from Salesforce on a scheduled sync (you control frequency) and it's enforced at the sequence level before any email goes out.\n\n3. **Outreach.io:** Yes — we can either run alongside Outreach (TechFlow handles the AI personalization, Outreach handles execution) or replace the sequencing layer entirely. Most teams do the hybrid approach first.\n\nI can share an architecture diagram if that's helpful. When's a good time for the technical walkthrough?\n\nAlex`,
          daysAgo: 28,
        },
        {
          from: CONTACTS.jennifer_rippling,
          to: [SDR.alex],
          cc: [CONTACTS.chris_rippling],
          body: `Alex,\n\nThat architecture makes sense. Architecture diagram would be appreciated — please send.\n\nI'm proposing a 2-week technical pilot with 10 reps from our SMB team to validate the Salesforce sync before we discuss broader rollout. Chris has approved the pilot budget.\n\nCan you send a pilot scope document?\n\nJennifer`,
          daysAgo: 22,
        },
      ],
      'needs_reply',
      ['enterprise', 'pilot', 'evaluating'],
    ),

    // Thread 5: Figma - Evaluating, multi-stakeholder (6 messages)
    T(
      'Figma enterprise outbound — are you open to a new approach?',
      inboxes.alex,
      [
        {
          from: SDR.alex,
          to: [CONTACTS.david_figma],
          body: `Hi David,\n\nFigma's go-to-market has always been best-in-class — the product-led motion you built is widely studied. Now that you're going deeper into enterprise, I imagine outbound is becoming more central.\n\nTechFlow AI works with CROs at design-adjacent SaaS companies who are navigating that same PLG-to-enterprise transition. We automate the outreach grunt work so your reps focus on relationships.\n\nUp for a 15-minute call? I'm available most of next week.\n\nAlex`,
          daysAgo: 28,
        },
        {
          from: CONTACTS.david_figma,
          to: [SDR.alex],
          body: `Alex,\n\nYour framing is accurate — enterprise motion is where a lot of my attention is right now.\n\nI'm cautious about AI outreach tools after some bad experiences with generic sequences that damaged our brand perception. What makes TechFlow different?\n\nWednesday 11am PT works if you want to walk me through it.\n\nDavid`,
          daysAgo: 27,
        },
        {
          from: SDR.alex,
          to: [CONTACTS.david_figma],
          body: `David,\n\nWednesday 11am — confirmed. I'll send an invite.\n\nOn your concern: fair, and I hear it from almost every CRO we talk to. The difference is control. Our AI writes first drafts, but reps always review and edit before anything sends. We have a hard no-send policy without human approval in the loop.\n\nWe also do something most tools don't: we analyze which messages get replies and which get ignored, then feed that back to the AI — so the system gets smarter about what Figma prospects actually respond to, not what generic datasets suggest.\n\nSee you Wednesday.\n\nAlex`,
          daysAgo: 27,
          hoursOffset: -1,
        },
        {
          from: CONTACTS.david_figma,
          to: [SDR.alex],
          cc: [CONTACTS.anna_figma],
          body: `Alex,\n\nGood call. I want Anna (RevOps Director) to evaluate the technical integration side. She's CC'd.\n\nAnna — TechFlow AI is the outreach tool I mentioned. Strong on brand safety controls. Can you do a technical review?\n\nDavid`,
          daysAgo: 23,
        },
        {
          from: CONTACTS.anna_figma,
          to: [SDR.alex, CONTACTS.david_figma],
          body: `Alex,\n\nHi — Anna here. A few things I'd need to understand:\n\n- How does data flow between TechFlow and our CRM (we use HubSpot)?\n- What's the data retention policy for prospect data stored in TechFlow?\n- Do you support SSO/SAML for enterprise accounts?\n\nAlso: do you have a security questionnaire pre-filled we can work from?\n\nAnna`,
          daysAgo: 22,
        },
        {
          from: SDR.alex,
          to: [CONTACTS.anna_figma, CONTACTS.david_figma],
          body: `Anna,\n\nHappy to answer all three:\n\n**HubSpot integration:** Bidirectional sync via HubSpot API v3. Contacts, deals, and activities sync in real-time. We also read your HubSpot suppression lists automatically.\n\n**Data retention:** Prospect data is retained for the duration of your contract plus 30 days. You can export everything at any time. We hold nothing after contract end.\n\n**SSO/SAML:** Yes — supported on Enterprise tier (which I'd recommend for Figma's size). We support Okta, Azure AD, and Google Workspace out of the box.\n\n**Security questionnaire:** Sending our pre-filled SIG Lite now. Should cover 80% of what your security team will ask.\n\nWhat's your timeline for making a decision?\n\nAlex`,
          daysAgo: 21,
        },
      ],
      'waiting',
      ['enterprise', 'evaluating', 'plg'],
    ),

    // Thread 6: Attio - Short, interested (3 messages)
    T(
      'Your CRM and our outreach layer — natural fit?',
      inboxes.alex,
      [
        {
          from: SDR.alex,
          to: [CONTACTS.oliver_attio],
          body: `Hi Oliver,\n\nI've been a fan of what Attio is building — CRM that actually reflects how modern GTM teams work.\n\nWe have a few mutual customers (companies using both Attio and TechFlow AI) and they've been asking us to build a tighter integration. Before we invest in that, I wanted to talk to someone at Attio directly.\n\nTwo questions: (1) Is an outreach automation integration something that would be valuable for your customers? (2) Would it be worth 20 minutes to explore what that could look like?\n\nAlex`,
          daysAgo: 18,
        },
        {
          from: CONTACTS.oliver_attio,
          to: [SDR.alex],
          body: `Alex,\n\nInteresting angle — pitching an integration rather than a direct sale. I appreciate the honesty.\n\nTo answer your questions: (1) Yes, our customers consistently ask for outreach automation that works natively with Attio's data model. (2) Yes, let's talk. I have time Thursday afternoon.\n\nOliver`,
          daysAgo: 17,
        },
        {
          from: SDR.alex,
          to: [CONTACTS.oliver_attio],
          body: `Oliver,\n\nThursday afternoon — I'll send a few time slots and you can pick what works.\n\nTo set expectations: I want to understand your customer use cases first before proposing anything technical. So mostly listening on this call.\n\nLooking forward to it.\n\nAlex`,
          daysAgo: 17,
          hoursOffset: -1,
        },
      ],
      'open',
      ['partnership', 'integration'],
    ),

    // Thread 7: Front - Cold, 1 message
    T(
      'Shared interest in AI + sales tooling',
      inboxes.alex,
      [
        {
          from: SDR.alex,
          to: [CONTACTS.ryan_front],
          body: `Hi Ryan,\n\nFront is doing interesting work on collaborative customer communication — I imagine the VP Sales role there involves a lot of cross-functional coordination alongside the normal pipeline pressures.\n\nAt TechFlow AI, we help VP Sales leaders automate their team's outbound so they can focus on exactly the kind of strategic work Front enables. Our customers at similar-stage companies typically go from 1.2 meetings/SDR/week to 3.8 within 90 days.\n\nWould a 15-minute call be worth it? Happy to share the specific playbook we use for collaborative sales environments like Front's.\n\nAlex`,
          daysAgo: 12,
        },
      ],
      'open',
      ['cold'],
    ),

    // Thread 8: Mercury - Enterprise, complex deal (8 messages)
    T(
      'AI outreach for Mercury\'s sales expansion',
      inboxes.alex,
      [
        {
          from: SDR.alex,
          to: [CONTACTS.william_mercury],
          body: `Hi William,\n\nMercury's growth in the fintech space has been impressive — moving upmarket to serve Series B+ companies requires a fundamentally different outbound motion than what works for early-stage startups.\n\nTechFlow AI works specifically with CROs who are navigating that upmarket transition. We helped Brex go from scrappy outbound to a structured, AI-powered enterprise motion over 6 months.\n\nI know you're discerning about the tools you bring in — would a 20-minute conversation be worth it?\n\nAlex`,
          daysAgo: 60,
        },
        {
          from: CONTACTS.william_mercury,
          to: [SDR.alex],
          body: `Alex,\n\nThe Brex reference is credible — I know their GTM team well.\n\nOur challenge isn't volume — it's precision. We're going after a specific ICP (Series B-D fintech and crypto-adjacent companies) and the outreach needs to feel warm and researched, not AI-generated.\n\nIf your tool can genuinely do that, I'm interested. 20 minutes next Tuesday.\n\nWilliam`,
          daysAgo: 59,
        },
        {
          from: SDR.alex,
          to: [CONTACTS.william_mercury],
          body: `William,\n\nTuesday works — invite sent.\n\nOn precision vs. volume: you're describing exactly what we're built for. The system does automated research on each prospect (recent funding, news, relevant LinkedIn activity) and incorporates it into the opening line of each email. It looks like your rep spent 10 minutes researching — because the AI did.\n\nYou control the ICP criteria, the signal sources, and the style guide. The rep still reviews before sending.\n\nSee you Tuesday.\n\nAlex`,
          daysAgo: 58,
        },
        {
          from: CONTACTS.william_mercury,
          to: [SDR.alex],
          cc: [CONTACTS.grace_mercury],
          body: `Alex,\n\nCall was exactly what I needed. Grace (VP Sales) is CC'd — she runs the team that would use this day-to-day and is the right person to evaluate fit.\n\nGrace, TechFlow AI does AI-powered outreach with research signals built in. Relevant for the upmarket push we've been discussing. Can you spend 30 min with Alex?\n\nWilliam`,
          daysAgo: 55,
        },
        {
          from: CONTACTS.grace_mercury,
          to: [SDR.alex, CONTACTS.william_mercury],
          body: `Alex,\n\nHi — Grace here. I'm doing calls all of next week so scheduling is tight, but I want to be direct: what I care about is rep adoption. I've seen AI tools that reps love in demos and hate in practice.\n\nTwo questions:\n1. What does the rep workflow actually look like day-to-day?\n2. What's your average rep adoption rate at 90 days?\n\nGrace`,
          daysAgo: 53,
        },
        {
          from: SDR.alex,
          to: [CONTACTS.grace_mercury, CONTACTS.william_mercury],
          body: `Grace,\n\nBrilliant question — rep adoption is the real metric.\n\n**Day-to-day workflow:**\n- Rep starts their day and sees a queue of personalized drafts (generated overnight for prospects they selected the day before)\n- Each draft takes ~45 seconds to review, tweak if needed, and approve with one click\n- They can also trigger on-demand drafts for hot prospects\n- No separate tool to log into — it's embedded in their CRM sidebar\n\n**Adoption at 90 days:** 78% of reps use it daily (our definition: >3 approvals per day). Industry baseline for sales tools is around 40%.\n\nHappy to connect you with our customer success manager at Brex — she tracks adoption metrics obsessively.\n\nAlex`,
          daysAgo: 52,
        },
        {
          from: CONTACTS.grace_mercury,
          to: [SDR.alex],
          cc: [CONTACTS.william_mercury, CONTACTS.henry_mercury],
          body: `Alex,\n\nThe 78% adoption stat is what I needed. Looping Henry (Legal) because we'll need to review data processing terms given our fintech regulatory requirements.\n\nHenry — TechFlow AI needs to go through our vendor security review. Can you prioritize?\n\nAlex — can you send your standard DPA and any fintech-specific compliance documentation you have?\n\nGrace`,
          daysAgo: 45,
        },
        {
          from: SDR.alex,
          to: [CONTACTS.grace_mercury, CONTACTS.william_mercury, CONTACTS.henry_mercury],
          body: `Henry, Grace, William —\n\nDocuments sent:\n- Master Services Agreement (standard)\n- Data Processing Agreement (with CCPA, GDPR, SOC 2)\n- Fintech vendor questionnaire (pre-filled, covers Bank Secrecy Act data handling)\n- SOC 2 Type II report (renewed January 2026)\n\nHenry — happy to hop on a call with your team to walk through any specific sections. Most fintech reviews focus on sections 7 (data residency) and 12 (breach notification). I can have those sections summarized in a one-pager if helpful.\n\nTimeline question for William and Grace: are we still targeting a Q2 launch?\n\nAlex`,
          daysAgo: 44,
        },
      ],
      'waiting',
      ['enterprise', 'legal-review', 'fintech'],
    ),

    // ─── INBOX 2: outreach@techflow.ai — Cold sequences ────────────────────

    // Thread 9: Lattice - Booked demo (4 messages)
    T(
      'How Lattice\'s sales team could use AI outreach',
      inboxes.outreach,
      [
        {
          from: SDR.outreach,
          to: [CONTACTS.maya_lattice],
          body: `Hi Maya,\n\nLattice's people management platform requires reps who understand HR buyer psychology — that's a nuanced sale that benefits from highly personalized outreach, not generic sequences.\n\nTechFlow AI builds outreach that actually reflects that nuance. We've helped CROs at HR-adjacent SaaS companies (Rippling, Culture Amp) run outbound that converts HR leaders specifically.\n\nIs there a 20-minute window this week to show you what that looks like for Lattice?\n\nTechFlow Outreach Team`,
          daysAgo: 25,
        },
        {
          from: CONTACTS.maya_lattice,
          to: [SDR.outreach],
          body: `Hi,\n\nI'm forwarding this to Kevin Zhang, our VP Sales — he owns the outreach stack.\n\nKevin — FYI, could be relevant.\n\nMaya`,
          daysAgo: 24,
        },
        {
          from: CONTACTS.kevin_lattice,
          to: [SDR.outreach],
          body: `Hi there,\n\nMaya forwarded your email. I've been looking at AI outreach tools for Q2.\n\nCan you send me a demo? Something I can watch async before committing to a call?\n\nKevin`,
          daysAgo: 23,
        },
        {
          from: SDR.outreach,
          to: [CONTACTS.kevin_lattice],
          cc: [CONTACTS.maya_lattice],
          body: `Kevin,\n\nAbsolutely — here's our 8-minute product overview: [loom.com/share/techflow-demo-2026]\n\nIf after watching that you want to see it live with your specific ICP criteria, I'm happy to do a personalized demo. I can also pull up a sample sequence for an HR persona specifically if that would make it more concrete.\n\nJust let me know — no pressure.\n\nTechFlow Outreach Team`,
          daysAgo: 22,
        },
      ],
      'open',
      ['demo-sent', 'evaluating'],
    ),

    // Thread 10: Descript - Cold sequence (2 messages, no reply to second)
    T(
      'Scaling Descript\'s outbound alongside your product growth',
      inboxes.outreach,
      [
        {
          from: SDR.outreach,
          to: [CONTACTS.noah_descript],
          body: `Hi Noah,\n\nDescript has built something genuinely differentiated in the video editing space — it's the kind of product that almost sells itself within creative teams, but enterprise expansion is a different game.\n\nAt TechFlow AI, we help SDR Managers at product-led companies build an outbound muscle without undermining the brand that made them successful.\n\nWould it be worth 20 minutes to compare notes on how you're currently approaching outbound?\n\nTechFlow Outreach Team`,
          daysAgo: 20,
        },
        {
          from: SDR.outreach,
          to: [CONTACTS.noah_descript],
          body: `Hi Noah,\n\nFollowing up on last week's email — I know things get busy.\n\nOne thing that might be useful: we just released a playbook for video/media SaaS companies running enterprise outbound. It covers how to approach outreach to creative directors vs. IT buyers vs. procurement — three very different conversations.\n\nHappy to send it over if that would be useful, no strings attached.\n\nTechFlow Outreach Team`,
          daysAgo: 13,
        },
      ],
      'open',
      ['cold', 'no-reply'],
    ),

    // Thread 11: Runway - Cold, 1 message (no reply)
    T(
      'AI outreach for Runway\'s enterprise push',
      inboxes.outreach,
      [
        {
          from: SDR.outreach,
          to: [CONTACTS.sophia_runway],
          body: `Hi Sophia,\n\nRunway's work in generative AI video is remarkable — you're pioneering a category, which makes the GTM challenge uniquely interesting.\n\nAs you build out enterprise, you're probably finding that outbound to creative directors and content leaders requires a very different approach than traditional B2B sales.\n\nTechFlow AI helps GTM teams in emerging categories (AI, creative tech) run outbound that speaks the prospect's language — not corporate sales-speak.\n\nIs a 15-minute call on your radar this month?\n\nTechFlow Outreach Team`,
          daysAgo: 15,
        },
      ],
      'open',
      ['cold'],
    ),

    // Thread 12: Hex - Partnership/integration interest (3 messages)
    T(
      'TechFlow + Hex integration — worth exploring?',
      inboxes.outreach,
      [
        {
          from: SDR.outreach,
          to: [CONTACTS.zoe_hex],
          body: `Hi Zoe,\n\nHex is the analytics layer a lot of our customers use alongside TechFlow AI — you're in the RevOps stack for them already.\n\nI've been wondering if there's a natural connection: Hex gives teams the data visibility to identify which outreach signals work, and TechFlow executes on them. Together that could be a compelling story for RevOps leaders.\n\nWould you be open to an exploratory call? Not a sales pitch — more of a "does this make sense?" conversation.\n\nTechFlow Outreach Team`,
          daysAgo: 22,
        },
        {
          from: CONTACTS.zoe_hex,
          to: [SDR.outreach],
          body: `Hi,\n\nInteresting framing — you're right that there's overlap in our customer base. I've seen a few companies trying to connect analytics-driven insights with outreach automation.\n\nLet's talk. Tuesday or Wednesday afternoon works for me.\n\nZoe`,
          daysAgo: 21,
        },
        {
          from: SDR.outreach,
          to: [CONTACTS.zoe_hex],
          body: `Zoe,\n\nTuesday 2pm PT works — invite sent.\n\nI'm thinking about this as a mutual data story: Hex shows "which prospect signals (job changes, funding, tech installs) correlate with deals closing in <45 days," TechFlow uses that as a trigger for outreach. For RevOps leaders who care about data-driven GTM, that's a compelling combination.\n\nLooking forward to the conversation.\n\nTechFlow Outreach Team`,
          daysAgo: 21,
          hoursOffset: -1,
        },
      ],
      'open',
      ['partnership', 'integration'],
    ),

    // Thread 13: Loom - Cold outreach (2 messages)
    T(
      'Loom\'s SDR efficiency — a thought',
      inboxes.outreach,
      [
        {
          from: SDR.outreach,
          to: [CONTACTS.claire_loom],
          body: `Hi Claire,\n\nLoom uses video to make async communication feel personal — which is exactly the challenge we're solving in sales outreach with AI.\n\nTechFlow AI helps sales teams personalize outreach at scale without it feeling like a template blast. Given Loom's use case, I imagine your buyers respond especially well to personalized, conversational outreach — which is exactly what we enable.\n\nWould a 20-minute call be useful?\n\nTechFlow Outreach Team`,
          daysAgo: 18,
        },
        {
          from: CONTACTS.claire_loom,
          to: [SDR.outreach],
          body: `Hi,\n\nThis is actually well-timed — we're evaluating our outreach stack for Q2. Can you send me more information before I commit to a call? Specifically curious about how you handle personalization at volume.\n\nClaire`,
          daysAgo: 17,
        },
      ],
      'needs_reply',
      ['interested', 'evaluating'],
    ),

    // ─── INBOX 3: enterprise@techflow.ai — Enterprise deals ─────────────────

    // Thread 14: Retool - Enterprise, multi-stakeholder, procurement involved (9 messages)
    T(
      'Enterprise sales automation for Retool',
      inboxes.enterprise,
      [
        {
          from: SDR.enterprise,
          to: [CONTACTS.priya_retool],
          body: `Hi Priya,\n\nRetool's enterprise sales motion is complex by design — you're selling to engineering leaders and business operators simultaneously, each with different buying criteria.\n\nTechFlow AI's enterprise tier is built for exactly this: multi-persona outreach, account-based plays, and AI that adapts its messaging based on the prospect's function (engineering vs. operations vs. finance).\n\nGiven the complexity of Retool's deals, would a 30-minute conversation be worth it? I can have our Head of Enterprise Sales join as well.\n\nTechFlow Enterprise Team`,
          daysAgo: 58,
        },
        {
          from: CONTACTS.priya_retool,
          to: [SDR.enterprise],
          body: `Hi,\n\nThe multi-persona angle is right for our business. Our deals involve anywhere from 3-8 stakeholders and we've been trying to figure out how to orchestrate outreach across them without it feeling random.\n\nLet's do 30 minutes. I have slots Thursday or Friday.\n\nPriya`,
          daysAgo: 57,
        },
        {
          from: SDR.enterprise,
          to: [CONTACTS.priya_retool],
          body: `Priya,\n\nThursday 1pm PT — invite sent.\n\nI'll prepare a walkthrough of how we handle account-based plays specifically: how you designate an account, set up parallel tracks for different personas, and track multi-thread progress without things falling through the cracks.\n\nSee you Thursday.\n\nTechFlow Enterprise Team`,
          daysAgo: 57,
          hoursOffset: -1,
        },
        {
          from: CONTACTS.priya_retool,
          to: [SDR.enterprise],
          cc: [CONTACTS.tom_retool],
          body: `Hi,\n\nOur call was great — this is definitely relevant for Retool. I'm looping Tom from Procurement — he'll need to evaluate any new vendor.\n\nTom: TechFlow AI is the enterprise outreach platform Priya was evaluating. We want to move quickly on this for Q2. Can you start the vendor onboarding process?\n\nPriya`,
          daysAgo: 53,
        },
        {
          from: CONTACTS.tom_retool,
          to: [SDR.enterprise],
          cc: [CONTACTS.priya_retool],
          body: `Hello,\n\nTom Anderson, Procurement at Retool. A few things we need before we can proceed:\n\n1. W-9 form (or W-8 if non-US entity)\n2. Certificate of insurance (COI) — minimum $2M general liability\n3. Master Vendor Agreement signed by an authorized signatory\n4. SOC 2 Type II report (within 12 months)\n5. References: 3 enterprise customers, verified by Procurement\n\nPlease send these to vendor-review@retool.com\n\nTom Anderson\nProcurement, Retool`,
          daysAgo: 51,
        },
        {
          from: SDR.enterprise,
          to: [CONTACTS.tom_retool, CONTACTS.priya_retool],
          body: `Tom,\n\nSending all five to vendor-review@retool.com now. Quick note on each:\n\n1. **W-9:** Attached (TechFlow AI, Inc., EIN: 88-XXXXXXX)\n2. **COI:** Attached — $3M general liability, $5M cyber liability\n3. **MVA:** Sending our standard form; we're open to Retool's paper if you prefer\n4. **SOC 2:** Attached — renewed January 2026, covers Security, Availability, Confidentiality\n5. **References:** Stripe (Sarah Chen, VP Sales), Mercury (Grace Liu, VP Sales), Notion (Emma Rodriguez, Head of Sales)\n\nTimeline question: once procurement review is complete, how quickly can we move to signature? Priya mentioned Q2 launch as the target.\n\nTechFlow Enterprise Team`,
          daysAgo: 50,
        },
        {
          from: CONTACTS.tom_retool,
          to: [SDR.enterprise],
          cc: [CONTACTS.priya_retool, CONTACTS.lisa_retool],
          body: `Hello,\n\nDocuments received. Looping Lisa Kim from Legal — she'll need to review the MVA and data processing terms.\n\nLisa — TechFlow AI vendor review. Please prioritize the DPA given our Q2 timeline.\n\nTom`,
          daysAgo: 47,
        },
        {
          from: CONTACTS.lisa_retool,
          to: [SDR.enterprise],
          cc: [CONTACTS.tom_retool, CONTACTS.priya_retool],
          body: `Hi,\n\nLisa Kim, Legal at Retool. I've reviewed the MVA and have redlines on sections 8 (indemnification), 11 (limitation of liability), and 14 (data deletion timeline).\n\nI'll send the redlined document to your legal team directly — can you provide a legal contact email?\n\nAlso: our DPA requires 72-hour breach notification (your document says 5 business days). This is non-negotiable for us.\n\nLisa`,
          daysAgo: 42,
        },
        {
          from: SDR.enterprise,
          to: [CONTACTS.lisa_retool, CONTACTS.tom_retool, CONTACTS.priya_retool],
          body: `Lisa,\n\nLegal contact: legal@techflow.ai — they're expecting your redlines.\n\nOn the 72-hour breach notification: yes, we can accommodate that. We'll update section 14.2 of our standard DPA to reflect 72 hours (calendar, not business days) — that's actually aligned with GDPR Article 33 so it's a reasonable update.\n\nPriya — are we still on track for Q2? The legal review typically adds 1-2 weeks once redlines are exchanged. If we target signature by February 28, we can do a March 15 launch.\n\nTechFlow Enterprise Team`,
          daysAgo: 40,
        },
      ],
      'waiting',
      ['enterprise', 'legal-review', 'procurement'],
    ),

    // Thread 15: Vercel - Bounced email, then found correct contact (3 messages)
    T(
      'TechFlow AI for Vercel\'s enterprise sales',
      inboxes.enterprise,
      [
        {
          from: SDR.enterprise,
          to: ['cto@vercel.com'],
          body: `Hi,\n\nI wanted to reach out about TechFlow AI's enterprise outreach capabilities — we work with several infrastructure and developer-tools companies to help their sales teams automate and scale outbound while maintaining the technical credibility that audiences like yours expect.\n\nWould someone on your team be open to a brief conversation?\n\nTechFlow Enterprise Team`,
          daysAgo: 40,
        },
        {
          from: SDR.enterprise,
          to: [CONTACTS.sam_vercel],
          body: `Hi Sam,\n\nI tried reaching out to your CTO earlier (email bounced) and found your profile as Director of BD — you're likely the more relevant person anyway.\n\nTechFlow AI works with developer-tools companies that are building enterprise sales motions. The typical challenge: your buyers are technical, skeptical of sales outreach, and have high standards for what they'll respond to. Our AI is trained on what actually works with technical audiences.\n\nWould 20 minutes make sense?\n\nTechFlow Enterprise Team`,
          daysAgo: 37,
        },
        {
          from: CONTACTS.sam_vercel,
          to: [SDR.enterprise],
          body: `Hi,\n\nAppreciate you finding me after the bounce. Honest answer: we're not actively evaluating outreach tools right now — we're focused on inbound and community-led GTM.\n\nThat said, I'll keep you in mind for Q3 when we revisit the outbound question.\n\nSam`,
          daysAgo: 36,
        },
      ],
      'closed',
      ['rejected', 'revisit-q3'],
    ),

    // ─── INBOX 4: demos@techflow.ai — Demo bookings ──────────────────────────

    // Thread 16: Notion - Post-demo follow-up (3 messages)
    T(
      'Re: TechFlow demo follow-up — next steps',
      inboxes.demos,
      [
        {
          from: SDR.demos,
          to: [CONTACTS.james_notion],
          body: `James,\n\nGreat to demo with you and Emma earlier today — you asked all the right questions.\n\nAs promised:\n1. Recording of today's session: [loom link]\n2. The HubSpot integration spec we walked through\n3. Sample sequences for PLG/enterprise outreach in the SaaS vertical\n\nNext step from our end: I'll set up a sandbox account for you so your team can explore before committing. Credentials will come from onboarding@techflow.ai in the next 24 hours.\n\nAny questions before then — just reply here.\n\nAlex Chen\nTechFlow AI`,
          daysAgo: 47,
        },
        {
          from: CONTACTS.james_notion,
          to: [SDR.demos],
          body: `Alex,\n\nThanks for the quick turnaround. The recording is helpful — I'm going to share it with two reps who'll use this most.\n\nOne question: in the sandbox, can we use our actual HubSpot data to test, or is it a separate environment with dummy data?\n\nJames`,
          daysAgo: 46,
        },
        {
          from: SDR.demos,
          to: [CONTACTS.james_notion],
          body: `James,\n\nYou can use a read-only HubSpot connection to your real data in the sandbox — it won't write anything back or trigger any sends. This way you see how your actual contacts would be organized and sequenced, without any risk.\n\nI've pre-configured that in your sandbox account. Login credentials just sent from onboarding@techflow.ai.\n\nLet me know how the exploration goes!\n\nAlex`,
          daysAgo: 46,
          hoursOffset: -2,
        },
      ],
      'waiting',
      ['demo-done', 'sandbox', 'closed-won'],
    ),

    // Thread 17: Rippling - Demo scheduled (2 messages)
    T(
      'Demo confirmed: TechFlow AI x Rippling — Tuesday 10am',
      inboxes.demos,
      [
        {
          from: SDR.demos,
          to: [CONTACTS.jennifer_rippling],
          cc: [CONTACTS.chris_rippling],
          body: `Jennifer, Chris,\n\nConfirming your demo for Tuesday at 10am PT. Zoom link: [meet.zoom.us/techflow-rippling]\n\nAgenda (30 min):\n- 5 min: Quick recap of your requirements from our earlier calls\n- 15 min: Live walkthrough of multi-persona sequencing with Salesforce/Outreach integration\n- 10 min: Q&A and sandbox access setup\n\nI'll have our Head of Integrations join for the technical sections.\n\nAlex Chen\nTechFlow AI`,
          daysAgo: 20,
        },
        {
          from: CONTACTS.jennifer_rippling,
          to: [SDR.demos],
          body: `Alex,\n\nConfirmed. One addition to the agenda: can you show the suppression list sync specifically? That's the thing I need to see work live before I'm comfortable recommending to Chris.\n\nJennifer`,
          daysAgo: 19,
        },
      ],
      'open',
      ['demo-scheduled'],
    ),

    // Thread 18: Stripe - Demo follow-up (separate from main thread) (3 messages)
    T(
      'TechFlow demo notes — action items for Stripe',
      inboxes.demos,
      [
        {
          from: SDR.demos,
          to: [CONTACTS.diana_stripe],
          cc: [CONTACTS.mike_stripe, CONTACTS.sarah_stripe],
          body: `Diana, Mike, Sarah,\n\nThank you for the extended demo session — really appreciated the depth of questions.\n\nKey action items we discussed:\n- TechFlow to send updated DPA reflecting 48-hour breach notification ✓ (sent)\n- Mike to share current Salesforce data model for integration planning\n- Sarah to identify 5 SDRs for the pilot cohort\n- Diana to get final approval from Finance for pilot budget\n\nTarget pilot start: March 1. We need the MSA signed by February 21 to make that work.\n\nI'll follow up on the MSA status next Wednesday.\n\nAlex Chen\nTechFlow AI`,
          daysAgo: 18,
        },
        {
          from: CONTACTS.mike_stripe,
          to: [SDR.demos],
          cc: [CONTACTS.diana_stripe, CONTACTS.sarah_stripe],
          body: `Alex,\n\nSharing our Salesforce object structure in a separate email (to the secure onboarding address). Quick note: we have some custom objects for our enterprise accounts that aren't standard Salesforce — wanted to flag that early so integration can account for them.\n\nMike`,
          daysAgo: 17,
        },
        {
          from: SDR.demos,
          to: [CONTACTS.mike_stripe, CONTACTS.diana_stripe, CONTACTS.sarah_stripe],
          body: `Mike,\n\nGot the data model — thank you. Custom objects aren't a problem; our Salesforce package supports custom object mapping through a configuration UI (no code required).\n\nI'll have our integration specialist review your specific objects and come back with a mapping proposal by end of week.\n\nDiana — checking in on the Finance approval. Any update?\n\nAlex`,
          daysAgo: 16,
        },
      ],
      'needs_reply',
      ['demo-done', 'action-items', 'enterprise'],
    ),

    // Thread 19: Lattice - Demo request (2 messages)
    T(
      'Demo request: TechFlow AI for Lattice',
      inboxes.demos,
      [
        {
          from: CONTACTS.kevin_lattice,
          to: [SDR.demos],
          body: `Hi,\n\nI watched the async demo and I'm interested. Can we schedule a live session where I can ask questions? Also want to bring our Head of Marketing since we've been discussing joint outreach campaigns.\n\nNext week works — Tuesday or Thursday afternoon.\n\nKevin Zhang\nVP Sales, Lattice`,
          daysAgo: 18,
        },
        {
          from: SDR.demos,
          to: [CONTACTS.kevin_lattice],
          body: `Kevin,\n\nGreat to hear the async demo landed! Thursday 2pm PT works — invite sent.\n\nFor the marketing angle: yes, TechFlow AI can run both SDR outreach and marketing-qualified sequences from the same platform. Would love to hear more about the joint campaigns you're envisioning.\n\nAlex Chen\nTechFlow AI`,
          daysAgo: 17,
        },
      ],
      'open',
      ['demo-scheduled', 'marketing-angle'],
    ),

    // ─── INBOX 5: partnerships@techflow.ai — Partner conversations ───────────

    // Thread 20: Brex - Partner discussion (5 messages)
    T(
      'TechFlow x Brex — mutual customer opportunity?',
      inboxes.partnerships,
      [
        {
          from: SDR.partnerships,
          to: [CONTACTS.alex_brex],
          body: `Hi Alex,\n\nWe've noticed a meaningful overlap between TechFlow AI's customer base and Brex's — several of our fastest-growing customers have moved from legacy cards to Brex as they've scaled.\n\nI'd love to explore whether there's a referral or co-marketing opportunity here. The simplest version: we feature Brex as a recommended fintech partner to our customers, and vice versa.\n\nWould 20 minutes to brainstorm make sense?\n\nAlex Chen\nPartnerships, TechFlow AI`,
          daysAgo: 35,
        },
        {
          from: CONTACTS.alex_brex,
          to: [SDR.partnerships],
          body: `Hi Alex,\n\nInteresting — we do have a partner program and referrals from SaaS vendors in our customers' stack tend to convert well.\n\nLooping Rachel Hong (BD Director) who manages our technology partnerships.\n\nAlex`,
          daysAgo: 34,
        },
        {
          from: CONTACTS.rachel_brex,
          to: [SDR.partnerships],
          cc: [CONTACTS.alex_brex],
          body: `Hi Alex,\n\nRachel here. We're definitely open to exploring. A few questions:\n\n1. What's your customer size range? (We focus on Series A through public)\n2. What does your current partner program look like (referral fees, co-marketing, etc.)?\n3. Do you have a partner portal we can apply through?\n\nRachel`,
          daysAgo: 33,
        },
        {
          from: SDR.partnerships,
          to: [CONTACTS.rachel_brex, CONTACTS.alex_brex],
          body: `Rachel,\n\nHappy to answer:\n\n1. **Customer size:** Series B through growth-stage, typically 50-500 employees. Strong overlap with Brex's Series A-C focus.\n\n2. **Partner program:** Revenue share (15% of first year contract value for referrals that close), co-branded content, and co-hosted webinars. We have ~12 active technology partners.\n\n3. **Partner portal:** Yes — partners.techflow.ai. I'll send you a direct invitation link with 48-hour priority review.\n\nWould a 30-minute call to walk through the program structure be useful?\n\nAlex Chen\nPartnerships, TechFlow AI`,
          daysAgo: 32,
        },
        {
          from: CONTACTS.rachel_brex,
          to: [SDR.partnerships],
          body: `Alex,\n\nThe program structure looks good. Let's do the 30-minute call — I have slots next Wednesday afternoon (after 2pm PT).\n\nOne thing to discuss on the call: we'd want to understand how TechFlow AI handles Brex referral attribution specifically, since we have a pretty specific attribution model on our end.\n\nRachel`,
          daysAgo: 28,
        },
      ],
      'open',
      ['partnership', 'revenue-share'],
    ),

    // Thread 21: Hex - Partnership follow-up (2 messages)
    T(
      'Re: TechFlow x Hex integration — technical alignment',
      inboxes.partnerships,
      [
        {
          from: SDR.partnerships,
          to: [CONTACTS.zoe_hex],
          body: `Zoe,\n\nFollowing up on our call last week — really enjoyed that conversation.\n\nI spoke with our engineering team about a native Hex integration. The good news: our data model exposes a clean API for outreach signal data (reply rates, sequence performance, prospect engagement scores) that could feed directly into a Hex workspace.\n\nWould it make sense to get our Head of Product on a call with you to explore what a "TechFlow Insights" template workspace in Hex might look like?\n\nAlex Chen\nPartnerships, TechFlow AI`,
          daysAgo: 18,
        },
        {
          from: CONTACTS.zoe_hex,
          to: [SDR.partnerships],
          body: `Alex,\n\nYes — a "TechFlow Insights" template in Hex is exactly the kind of thing our power users would love. Revenue teams using Hex already want pre-built analytics for their GTM stack.\n\nI'll loop in our Head of Product (Ben Torres) for the next call. Can you propose some times?\n\nZoe`,
          daysAgo: 17,
        },
      ],
      'open',
      ['partnership', 'integration', 'product-collab'],
    ),

    // Thread 22: Attio - Partnership / integration (bounced first, then found right contact)
    T(
      'TechFlow + Attio CRM integration',
      inboxes.partnerships,
      [
        {
          from: SDR.partnerships,
          to: ['partnerships@attio.com'],
          body: `Hi Attio team,\n\nI'm reaching out about a potential native integration between TechFlow AI and Attio CRM. We have mutual customers who are using both tools and manually syncing data between them — there's a clear opportunity to streamline that.\n\nIs there someone on your partnerships or BD team I should connect with?\n\nAlex Chen\nPartnerships, TechFlow AI`,
          daysAgo: 22,
        },
        {
          from: SDR.partnerships,
          to: [CONTACTS.oliver_attio],
          body: `Oliver,\n\nI sent a note to your partnerships inbox last week and also reached out to you from our main SDR inbox about an integration opportunity.\n\nWanted to make sure this was on your radar — we have a handful of customers using both Attio and TechFlow who would benefit from a native integration. Happy to explore this whenever is convenient.\n\nAlex\nPartnerships, TechFlow AI`,
          daysAgo: 17,
        },
      ],
      'open',
      ['partnership', 'integration'],
    ),

    // Thread 23: Mercury (partnerships angle - separate from main deal) (2 messages)
    T(
      'TechFlow referral for Mercury — fintech SDR playbook',
      inboxes.partnerships,
      [
        {
          from: SDR.partnerships,
          to: [CONTACTS.william_mercury],
          body: `William,\n\nSeparate from our ongoing commercial conversation: I wanted to share our Fintech SDR Playbook — it's a 20-page guide on outbound strategy specifically for B2B fintech companies targeting Series A-C prospects.\n\nGiven Mercury's position, I thought you might find it useful to share with your network, and potentially feature on your Resources page (we'd be happy to do the same for Mercury content on ours).\n\nNo strings attached — happy to send it over.\n\nAlex\nPartnerships, TechFlow AI`,
          daysAgo: 50,
        },
        {
          from: CONTACTS.william_mercury,
          to: [SDR.partnerships],
          body: `Alex,\n\nI like the value-first approach. Please send the playbook — I'll read it and if it's genuinely useful, I'm happy to share it with our founder network.\n\nWilliam`,
          daysAgo: 49,
        },
      ],
      'open',
      ['content-partnership'],
    ),

    // Thread 24: Loom - Feature partnership (2 messages)
    T(
      'Loom + TechFlow AI: video outreach integration?',
      inboxes.partnerships,
      [
        {
          from: SDR.partnerships,
          to: [CONTACTS.marcus_loom],
          body: `Hi Marcus,\n\nLoom is already embedded in many of our customers' outreach workflows — reps record a quick Loom, drop the link in a TechFlow-generated email, and get 2-3x higher reply rates on those messages.\n\nI've been thinking: is there a way to make that workflow native? A TechFlow + Loom integration where reps can record and embed Loom videos directly in their outreach sequences without leaving the platform.\n\nWould someone at Loom be interested in exploring this?\n\nAlex\nPartnerships, TechFlow AI`,
          daysAgo: 14,
        },
        {
          from: CONTACTS.marcus_loom,
          to: [SDR.partnerships],
          body: `Alex,\n\nThis is a great idea — we've heard similar feedback from customers about wanting Loom embedded in their outreach tools.\n\nLet me bring this to our integrations team. Can I connect you with our Head of Platform Partnerships? His name is Jordan and he owns these types of native integrations.\n\nMarcus`,
          daysAgo: 13,
        },
      ],
      'open',
      ['partnership', 'video-integration'],
    ),

    // More cold sequences - outreach inbox
    T(
      'Q2 pipeline generation — a question for you',
      inboxes.outreach,
      [
        {
          from: SDR.outreach,
          to: ['james.anderson@intercom.com'],
          body: `Hi James,\n\nIntercom's shift toward enterprise over the past 18 months has been impressive. The challenge: enterprise outbound requires a precision that doesn't always scale with traditional sequencing tools.\n\nTechFlow AI helps enterprise sales teams automate personalized outbound at scale — not generic templates, but AI that actually researches each prospect.\n\nWould a 15-minute call make sense this week?\n\nTechFlow Outreach Team`,
          daysAgo: 10,
        },
      ],
      'open',
      ['cold'],
    ),

    T(
      'Your SDR team and AI — worth a conversation?',
      inboxes.outreach,
      [
        {
          from: SDR.outreach,
          to: ['sarah.mills@clearbit.com'],
          body: `Hi Sarah,\n\nClearbit's data platform is used by a lot of the same SDR teams we work with — your enrichment data feeds directly into the kind of personalized outreach TechFlow AI enables.\n\nCurious: how are your customers typically using Clearbit data to personalize outreach today? I'm wondering if there's a natural fit between what you offer and what we do.\n\nAlex\nTechFlow Outreach Team`,
          daysAgo: 8,
        },
      ],
      'open',
      ['cold', 'data-partner'],
    ),

    T(
      'AI outreach + Salesforce native — Outreach.io replacement?',
      inboxes.outreach,
      [
        {
          from: SDR.outreach,
          to: ['mike.chen@zendesk.com'],
          body: `Hi Mike,\n\nZendesk's sales team runs a sophisticated CX-focused outreach motion — your prospects know customer experience, so your outreach needs to demonstrate it.\n\nTechFlow AI helps sales teams run outreach that's genuinely personalized (not just [FirstName]) — referencing specific company news, tech stack signals, and hiring patterns in every opening line.\n\nIs this on your radar for Q2?\n\nTechFlow Outreach Team`,
          daysAgo: 5,
        },
      ],
      'open',
      ['cold'],
    ),
  ];
}

// ─── Thread metadata definitions ──────────────────────────────────────────────

const THREAD_METADATA: Record<
  number,
  { status: 'open' | 'needs_reply' | 'waiting' | 'closed'; tags: string[]; extracted: Record<string, unknown> }
> = {
  0: {
    status: 'needs_reply',
    tags: ['enterprise', 'negotiating', 'hot'],
    extracted: {
      deal_stage: 'negotiating',
      sentiment: 'positive',
      company_name: 'Stripe',
      topics: ['pricing', 'integration', 'compliance', 'pilot'],
      deal_value_estimate: 'high',
      next_action: 'send MSA',
      key_contacts: [
        { email: CONTACTS.sarah_stripe, name: 'Sarah Chen', role: 'VP Sales', sentiment: 'positive' },
        { email: CONTACTS.mike_stripe, name: 'Mike Johnson', role: 'RevOps Director', sentiment: 'positive' },
        { email: CONTACTS.diana_stripe, name: 'Diana Park', role: 'CRO', sentiment: 'positive' },
      ],
      relationships: [{ from: CONTACTS.diana_stripe, to: CONTACTS.sarah_stripe, type: 'manages' }],
    },
  },
  1: {
    status: 'closed',
    tags: ['closed-won', 'reference-customer'],
    extracted: {
      deal_stage: 'closed_won',
      sentiment: 'positive',
      company_name: 'Notion',
      topics: ['plg', 'enterprise', 'hubspot'],
      deal_value_estimate: 'medium',
      next_action: 'closed',
      key_contacts: [
        { email: CONTACTS.emma_notion, name: 'Emma Rodriguez', role: 'Head of Sales', sentiment: 'positive' },
        { email: CONTACTS.james_notion, name: 'James Wu', role: 'SDR Manager', sentiment: 'positive' },
      ],
      relationships: [{ from: CONTACTS.emma_notion, to: CONTACTS.james_notion, type: 'manages' }],
    },
  },
  2: {
    status: 'open',
    tags: ['cold', 'no-reply'],
    extracted: {
      deal_stage: 'cold',
      sentiment: 'neutral',
      company_name: 'Linear',
      topics: ['outbound', 'sdrs'],
      deal_value_estimate: 'low',
      next_action: 'follow up',
      key_contacts: [{ email: CONTACTS.josh_linear, name: 'Josh Miller', role: 'SDR Manager', sentiment: 'neutral' }],
      relationships: [],
    },
  },
  3: {
    status: 'needs_reply',
    tags: ['enterprise', 'pilot', 'evaluating'],
    extracted: {
      deal_stage: 'evaluating',
      sentiment: 'positive',
      company_name: 'Rippling',
      topics: ['multi-persona', 'salesforce', 'integration', 'outreach.io', 'suppression'],
      deal_value_estimate: 'high',
      next_action: 'send pilot scope document',
      key_contacts: [
        { email: CONTACTS.chris_rippling, name: 'Chris Evans', role: 'VP Sales', sentiment: 'positive' },
        { email: CONTACTS.jennifer_rippling, name: 'Jennifer Liu', role: 'Head of RevOps', sentiment: 'evaluating' },
      ],
      relationships: [{ from: CONTACTS.chris_rippling, to: CONTACTS.jennifer_rippling, type: 'works_with' }],
    },
  },
  4: {
    status: 'waiting',
    tags: ['enterprise', 'evaluating', 'plg'],
    extracted: {
      deal_stage: 'evaluating',
      sentiment: 'positive',
      company_name: 'Figma',
      topics: ['plg', 'brand-safety', 'hubspot', 'security', 'sso'],
      deal_value_estimate: 'high',
      next_action: 'wait for security review',
      key_contacts: [
        { email: CONTACTS.david_figma, name: 'David Lee', role: 'CRO', sentiment: 'positive' },
        { email: CONTACTS.anna_figma, name: 'Anna White', role: 'RevOps Director', sentiment: 'evaluating' },
      ],
      relationships: [{ from: CONTACTS.david_figma, to: CONTACTS.anna_figma, type: 'works_with' }],
    },
  },
};

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 TechFlow AI SDR Demo Seeder');
  console.log('================================\n');

  // Connect to MongoDB
  console.log('📡 Connecting to MongoDB...');
  const db = await connect();
  if (!db) {
    console.error('❌ Failed to connect to MongoDB. Check MONGO_URL env var.');
    process.exit(1);
  }
  console.log(`✅ Connected to ${db.databaseName}\n`);

  // Find user's orgId
  console.log('🔍 Looking up user orgId...');
  const usersCollection = await getCollection('users');
  let orgId: string | null = null;

  if (usersCollection) {
    const user = await usersCollection.findOne({
      email: { $regex: 'shanjai', $options: 'i' },
    }) as { orgId?: string } | null;
    if (user?.orgId) {
      orgId = user.orgId;
      console.log(`✅ Found user org: ${orgId}\n`);
    }
  }

  if (!orgId) {
    // Fallback: look at any org
    const orgsCollection = await getCollection('organizations');
    if (orgsCollection) {
      const org = await orgsCollection.findOne({}) as { id?: string } | null;
      orgId = org?.id || `org_demo_${randomUUID()}`;
    } else {
      orgId = `org_demo_${randomUUID()}`;
    }
    console.log(`⚠️  Sanjay not found, using orgId: ${orgId}\n`);
  }

  // Create / update demo domain
  console.log(`🌐 Creating domain: ${DEMO_DOMAIN_NAME}`);
  await domainStore.upsertDomain({
    id: DEMO_DOMAIN_ID,
    name: DEMO_DOMAIN_NAME,
    orgId,
    status: 'active',
    createdAt: new Date().toISOString(),
  });
  console.log(`✅ Domain created: ${DEMO_DOMAIN_NAME}\n`);

  // Create 5 inboxes
  console.log('📬 Creating 5 SDR inboxes...');
  for (const inbox of INBOXES) {
    await domainStore.upsertInbox({
      domainId: DEMO_DOMAIN_ID,
      orgId,
      inbox: {
        id: inbox.id,
        localPart: inbox.localPart,
        address: `${inbox.localPart}@${DEMO_DOMAIN_NAME}`,
        displayName: `TechFlow AI — ${inbox.label}`,
        status: 'active',
        createdAt: new Date().toISOString(),
      },
    });
    console.log(`  ✅ ${inbox.localPart}@${DEMO_DOMAIN_NAME} (${inbox.label})`);
  }
  console.log();

  // Build and insert all threads
  const threads = buildThreads(orgId);
  console.log(`💬 Inserting ${threads.length} threads with realistic conversations...`);

  let totalMessages = 0;
  const insertedThreadIds: string[] = [];

  for (let i = 0; i < threads.length; i++) {
    const thread = threads[i];
    try {
      const { threadId, messageCount } = await insertThread(thread);
      insertedThreadIds.push(threadId);
      totalMessages += messageCount;

      // Set thread metadata
      const meta = THREAD_METADATA[i];
      if (meta) {
        await upsertThreadMetadata(threadId, orgId, meta.status, meta.tags, meta.extracted);
      } else {
        const defaultStatus = thread.status || 'open';
        const defaultTags = thread.tags || [];
        await upsertThreadMetadata(threadId, orgId, defaultStatus, defaultTags, {
          deal_stage: defaultStatus === 'closed' ? 'closed_won' : 'cold',
          company_name: 'Unknown',
          topics: [],
        });
      }

      const preview = thread.subject.length > 50 ? thread.subject.slice(0, 50) + '...' : thread.subject;
      console.log(
        `  [${String(i + 1).padStart(2, '0')}/${threads.length}] ` +
          `${thread.inboxAddress.split('@')[0].padEnd(14)} | ` +
          `${String(messageCount).padStart(2)} msgs | ${preview}`,
      );
    } catch (err) {
      console.error(`  ❌ Failed to insert thread "${thread.subject}":`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`\n✅ Done!`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📊 Summary:`);
  console.log(`   Threads inserted:  ${insertedThreadIds.length}`);
  console.log(`   Total messages:    ${totalMessages}`);
  console.log(`   Domain:            ${DEMO_DOMAIN_NAME}`);
  console.log(`   Inboxes:           ${INBOXES.length}`);
  console.log(`   OrgId:             ${orgId}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`\n🎯 Next steps:`);
  console.log(`   1. Run: npx ts-node -r dotenv/config src/scripts/extract-graph-metadata.ts`);
  console.log(`   2. Check inbox in dashboard: /dashboard/inboxes`);
  console.log(`   3. View graph at: /dashboard/inboxes/graph`);

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
