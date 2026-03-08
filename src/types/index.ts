// ─── Consolidated Type Exports ──────────────────────────────────
// All types re-exported from a single entry point.
// Import from '../types' resolves here.

export * from './messages';
export * from './domains';
export * from './auth';
export * from './delivery';
export * from './spam';
export * from './search';
export * from './qdrant';

// Re-export webhook types
export type { SvixHeaders, InboundEmailWebhookPayload } from './webhooks';

// Re-export deletion types
export * from './deletion';

// Re-export phone / SMS types
export * from './phone';
