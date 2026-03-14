import { z } from 'zod';
import { stripCRLF } from '../lib/sanitize';

// Email validation
const emailSchema = z.string().email('Invalid email address').toLowerCase();

// Email schema that also accepts "Display Name <email@domain.com>" format (for from/cc/bcc/reply_to)
// Validates the email part but preserves the full "Name <email>" string for SES FromEmailAddress
const displayEmailSchema = z.string().refine((val) => {
  const trimmed = val.trim();
  const match = trimmed.match(/<([^>]+)>/);
  const emailPart = match ? match[1].trim() : trimmed;
  return z.string().email().safeParse(emailPart).success;
}, 'Invalid email address');

// Loose recipient schema — real validation happens in EmailValidationService
// which gives per-recipient rejection/warnings instead of failing the whole request
const recipientSchema = z.string().min(1, 'Recipient email is required').max(320);

// Send email schema
export const SendEmailSchema = z.object({
  to: z
    .union([recipientSchema, z.array(recipientSchema).min(1, 'At least one recipient required')])
    .transform((val) => (Array.isArray(val) ? val : [val])),
  from: displayEmailSchema.optional(),
  subject: z.string().min(1, 'Subject is required').max(500, 'Subject too long').transform(stripCRLF),
  html: z.string().max(10_000_000, 'HTML content too large').optional(),
  text: z.string().max(10_000_000, 'Text content too large').optional(),
  cc: z.union([displayEmailSchema, z.array(displayEmailSchema)]).optional(),
  bcc: z.union([displayEmailSchema, z.array(displayEmailSchema)]).optional(),
  reply_to: displayEmailSchema.optional(),
  replyTo: displayEmailSchema.optional(),
  thread_id: z.string().optional(),
  domainId: z.string().optional(),
  domain_id: z.string().optional(),
  inboxId: z.string().optional(),
  inbox_id: z.string().optional(),
  attachments: z
    .array(
      z.union([
        z.string(),
        z.object({
          filename: z.string().transform(stripCRLF),
          content: z.string(),
          content_type: z.string().optional(),
        }),
      ])
    )
    .optional()
    .default([]),
  headers: z.record(z.string()).optional()
    .transform(val => {
      if (!val) return val;
      const cleaned: Record<string, string> = {};
      for (const [k, v] of Object.entries(val)) {
        cleaned[stripCRLF(k)] = stripCRLF(v);
      }
      return cleaned;
    }),
}).transform((data) => {
  const { inbox_id, domain_id, ...rest } = data;
  return {
    ...rest,
    inboxId: rest.inboxId || inbox_id,
    domainId: rest.domainId || domain_id,
  };
});

// Create domain schema
export const CreateDomainSchema = z.object({
  name: z.string().min(1, 'Domain name required'),
  region: z.enum(['us-east-1', 'eu-west-1']).optional(),
  capabilities: z.array(z.string()).optional(),
});

// Signup schema
export const SignupSchema = z.object({
  email: emailSchema,
  name: z.string().min(1, 'Name required').max(100),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  orgName: z.string().optional(),
  orgSlug: z.string().optional(),
});

// Signin schema
export const SigninSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password required'),
});

// Verify email schema
export const VerifyEmailSchema = z.object({
  token: z.string().min(1, 'Token required'),
});

// Create API key schema
export const CreateApiKeySchema = z.object({
  name: z.string().min(1, 'Name required').max(100),
  permissions: z.array(z.string()).optional(),
  expiresIn: z.number().optional(),
});

// Query pagination schema
export const PaginationSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1, 'Limit must be at least 1')
    .max(1000, 'Limit cannot exceed 1000')
    .default(50),
  offset: z.number().int().min(0, 'Offset must be non-negative').default(0),
});

// Helper to get query pagination with defaults
export const parseQueryPagination = (query: any) => {
  return PaginationSchema.parse({
    limit: query.limit ? Number(query.limit) : 50,
    offset: query.offset ? Number(query.offset) : 0,
  });
};
