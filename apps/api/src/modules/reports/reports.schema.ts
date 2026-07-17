/**
 * Reports request DTOs.
 */
import { z } from 'zod';

export const fileBody = z
  .object({
    handle: z.string().trim().toLowerCase().regex(/^[a-z0-9._]{3,30}$/).optional(),
    reportedNumber: z.string().trim().regex(/^\+?[1-9]\d{7,14}$/).optional(),
    reasonType: z.enum(['spam_scam', 'harassment', 'impersonation', 'inappropriate', 'other']),
    note: z.string().trim().max(1000).optional(),
    contextType: z.enum(['call', 'chat', 'contact', 'profile', 'number', 'business']).optional(),
    contextId: z.string().max(120).optional(),
    blockAlso: z.boolean().optional(),
  })
  .refine((b) => Boolean(b.handle) || Boolean(b.reportedNumber), {
    message: 'Provide a handle or a phone number to report.',
  });
