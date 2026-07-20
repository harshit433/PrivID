/**
 * Approval-request DTOs. Creating a request is authenticated (TrustRoute's own
 * step-up today; a partner relying-party API is the deferred B2B piece).
 */
import { z } from 'zod';

export const createApprovalBody = z.object({
  relyingParty: z.string().trim().min(1).max(80),
  action: z.string().trim().min(1).max(200),
  expiresInSeconds: z.number().int().min(30).max(600).optional(),
  context: z.record(z.string(), z.string().max(200)).optional(),
});

export const respondApprovalBody = z.object({
  decision: z.enum(['approve', 'deny']),
});

export const listApprovalsQuery = z.object({
  status: z.enum(['pending', 'approved', 'denied', 'expired']).optional(),
});

export const approvalIdParam = z.object({ requestId: z.string().uuid() });
