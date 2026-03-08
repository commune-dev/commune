/**
 * Vector Search Test Script
 *
 * Verifies that both email and SMS messages are correctly indexed and
 * searchable via semantic and phone-number-specific queries.
 *
 * Run:
 *   cd backend && npx ts-node -r dotenv/config src/scripts/test-vector-search.ts
 *
 * Cleanup:
 *   The script attempts to delete its own test vectors on completion.
 *   If it exits abnormally, manually delete the Qdrant collection:
 *     org_test-vector-search-org_conversations
 */

import { connect } from '../db';
import logger from '../utils/logger';

const TEST_ORG_ID = 'test-vector-search-org';
const TEST_SMS_ID = 'sms_test_vector_001';
const TEST_EMAIL_ID = 'email_test_vector_001';

const testSmsMessage = {
  orgId: TEST_ORG_ID,
  channel: 'sms' as const,
  message_id: TEST_SMS_ID,
  thread_id: 'thread_sms_test_001',
  direction: 'inbound' as const,
  participants: [
    { role: 'sender', identity: '+15551234567' },
    { role: 'to', identity: '+18005559999' },
  ],
  content: 'My package has not arrived and I need a refund for my order',
  attachments: [],
  created_at: new Date().toISOString(),
  metadata: {
    created_at: new Date().toISOString(),
    subject: undefined,
    domain_id: null,
    inbox_id: 'pn_test_phone_001',
    delivery_status: 'delivered',
    phone_number_id: 'pn_test_phone_001',
    from_number: '+15551234567',
    to_number: '+18005559999',
    twilio_sid: 'SM_test_001',
    sms_segments: 1,
    credits_charged: 1,
    num_media: 0,
  },
};

// EmailProcessor reads: metadata.inbox_id, metadata.domain_id, metadata.subject, attachments, direction
const testEmailMessage = {
  orgId: TEST_ORG_ID,
  channel: 'email' as const,
  message_id: TEST_EMAIL_ID,
  thread_id: 'thread_email_test_001',
  direction: 'inbound' as const,
  participants: [
    { role: 'sender', identity: 'customer@example.com' },
    { role: 'to', identity: 'support@commune.email' },
  ],
  content: 'Hi, I placed an order last week and it still has not been delivered. Can I get a refund?',
  attachments: [],
  created_at: new Date().toISOString(),
  metadata: {
    created_at: new Date().toISOString(),
    subject: 'Missing order refund request',
    domain_id: 'commune.email',
    inbox_id: 'inbox_test_001',
    delivery_status: 'delivered',
    // Required by EmailProcessor (falls back to '' if undefined, but explicit is safer)
    from_number: null,
    to_number: null,
    phone_number_id: null,
  },
};

async function runTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  const check = (label: string, condition: boolean) => {
    if (condition) {
      console.log(`  ✓ ${label}`);
      passed++;
    } else {
      console.log(`  ✗ ${label}`);
      failed++;
    }
  };

  // Lazy-load to avoid crashing if env vars are missing at module load time
  const { SmsProcessor } = await import('../services/sms/smsProcessor');
  const { EmailProcessor } = await import('../services/emailProcessor');
  const { SearchService } = await import('../services/searchService');
  const { QdrantService } = await import('../services/qdrantService');

  const smsProcessor = SmsProcessor.getInstance();
  const emailProcessor = EmailProcessor.getInstance();
  const searchService = SearchService.getInstance();
  const qdrantService = QdrantService.getInstance();

  // ── 1. Index test messages ────────────────────────────────────────
  console.log('\n1. Indexing test messages...');
  try {
    await smsProcessor.processMessage(testSmsMessage as any);
    console.log('   SMS indexed.');
  } catch (err) {
    console.error('   SMS indexing failed:', err);
    failed++;
  }

  try {
    await emailProcessor.processMessage(testEmailMessage as any);
    console.log('   Email indexed.');
  } catch (err) {
    console.error('   Email indexing failed:', err);
    failed++;
  }

  // Brief wait for Qdrant to make vectors searchable
  await new Promise(r => setTimeout(r, 1500));

  // ── 2. Semantic search — SMS ──────────────────────────────────────
  console.log('\n2. Semantic search (SMS): "delivery problem need refund"');
  try {
    const results = await searchService.search(
      TEST_ORG_ID,
      'delivery problem need refund',
      { organizationId: TEST_ORG_ID, channel: 'sms' },
      { limit: 5, minScore: 0.1 }
    );
    check('Returns results', results.length > 0);
    check('Test SMS found in results', results.some(r => r.metadata.threadId === 'thread_sms_test_001'));
  } catch (err) {
    console.error('   Error:', err);
    failed++;
  }

  // ── 3. Phone number filter — fromNumber ───────────────────────────
  console.log('\n3. Phone filter search: fromNumber=+15551234567');
  try {
    const results = await searchService.search(
      TEST_ORG_ID,
      'package refund',
      { organizationId: TEST_ORG_ID, channel: 'sms', fromNumber: '+15551234567' } as any,
      { limit: 5, minScore: 0.05 }
    );
    check('Returns results', results.length > 0);
    check('All results have correct fromNumber', results.every(r => {
      const meta = r.metadata as any;
      return meta.fromNumber === '+15551234567';
    }));
  } catch (err) {
    console.error('   Error:', err);
    failed++;
  }

  // ── 4. Semantic search — Email ────────────────────────────────────
  console.log('\n4. Semantic search (Email): "missing order refund"');
  try {
    const results = await searchService.search(
      TEST_ORG_ID,
      'missing order refund',
      { organizationId: TEST_ORG_ID, channel: 'email' },
      { limit: 5, minScore: 0.1 }
    );
    check('Returns results', results.length > 0);
    check('Test email found in results', results.some(r => r.metadata.threadId === 'thread_email_test_001'));
  } catch (err) {
    console.error('   Error:', err);
    failed++;
  }

  // ── 5. Cross-channel search (no channel filter) ───────────────────
  console.log('\n5. Cross-channel search: "refund order"');
  try {
    const results = await searchService.search(
      TEST_ORG_ID,
      'refund order',
      { organizationId: TEST_ORG_ID },
      { limit: 10, minScore: 0.1 }
    );
    const channels = new Set(results.map(r => r.metadata.channel));
    check('Returns results from multiple channels', channels.size > 1);
  } catch (err) {
    console.error('   Error:', err);
    failed++;
  }

  // ── 6. Org isolation — wrong org should return nothing ────────────
  console.log('\n6. Org isolation: wrong org should return no results');
  try {
    const results = await searchService.search(
      'other-org-id',
      'refund order',
      { organizationId: 'other-org-id' },
      { limit: 5, minScore: 0.05 }
    );
    check('No results for different org', results.length === 0);
  } catch (err) {
    // Expected if collection doesn't exist for other-org-id
    check('No results for different org', true);
  }

  // ── Cleanup ───────────────────────────────────────────────────────
  console.log('\n7. Cleaning up test vectors...');
  try {
    await qdrantService.deletePoints(TEST_ORG_ID, [TEST_SMS_ID, TEST_EMAIL_ID]);
    console.log('   Test vectors deleted.');
  } catch (err) {
    console.warn('   Cleanup failed (manual cleanup may be needed):', (err as Error).message);
  }

  return { passed, failed };
}

async function main() {
  console.log('Vector Search Test Script');
  console.log('=========================');

  if (!process.env.QDRANT_URL || !process.env.AZURE_OPENAI_EMBEDDING_API_KEY) {
    console.error('\nError: QDRANT_URL and AZURE_OPENAI_EMBEDDING_API_KEY must be set.');
    console.error('Run with: npx ts-node -r dotenv/config src/scripts/test-vector-search.ts');
    process.exit(1);
  }

  try {
    await connect();
    const { passed, failed } = await runTests();

    console.log(`\n${'─'.repeat(40)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);

    if (failed > 0) {
      console.log('\nSome tests failed. Check QDRANT_URL, AZURE_OPENAI_EMBEDDING_API_KEY, and network connectivity.');
      process.exit(1);
    } else {
      console.log('\nAll tests passed. Vector search is working correctly.');
      process.exit(0);
    }
  } catch (err) {
    console.error('\nFatal error:', err);
    process.exit(1);
  }
}

main();
