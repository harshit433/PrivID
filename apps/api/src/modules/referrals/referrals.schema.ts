/**
 * Referrals request DTOs.
 */
import { z } from 'zod';

export const applyBody = z.object({ code: z.string().trim().min(4).max(20) });

export const addMethodBody = z.object({
  type: z.enum(['upi', 'bank']),
  value: z.string().trim().min(3).max(120),
  holderName: z.string().trim().max(120).optional(),
  isDefault: z.boolean().optional(),
});

export const payoutBody = z.object({
  amountPaise: z.number().int().min(1).max(100_000_000),
  methodId: z.string().uuid(),
});

export const methodIdParam = z.object({ methodId: z.string().uuid() });
