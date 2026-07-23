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

/**
 * Reporting a phone number. The app sends `phone_number` + `reason`; the
 * canonical `reportedNumber`/`reasonType` names are accepted too so either
 * shape works.
 */
export const numberBody = z
  .object({
    phoneNumber: z.string().trim().regex(/^\+?[1-9]\d{7,14}$/).optional(),
    reportedNumber: z.string().trim().regex(/^\+?[1-9]\d{7,14}$/).optional(),
    reason: z.enum(['spam_scam', 'harassment', 'impersonation', 'inappropriate', 'other']).optional(),
    reasonType: z.enum(['spam_scam', 'harassment', 'impersonation', 'inappropriate', 'other']).optional(),
    note: z.string().trim().max(1000).optional(),
    contextType: z.enum(['call', 'chat', 'contact', 'profile', 'number', 'business']).optional(),
    contextId: z.string().max(120).optional(),
  })
  .refine((b) => Boolean(b.phoneNumber || b.reportedNumber), {
    message: 'Enter a valid phone number.',
    path: ['phoneNumber'],
  })
  .refine((b) => Boolean(b.reason || b.reasonType), {
    message: 'Choose a reason for the report.',
    path: ['reason'],
  });
