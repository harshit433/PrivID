/**
 * Wallet request DTOs.
 */
import { z } from 'zod';
import { paginationQuery } from '@trustroute/core';

export const listQuery = paginationQuery;

export const topupBody = z.object({ packId: z.string().min(1).max(40) });

export const verifyBody = z.object({
  orderId: z.string().min(1).max(120),
  paymentId: z.string().min(1).max(120),
  signature: z.string().min(1).max(256),
});

export const autoRechargeBody = z.object({
  enabled: z.boolean(),
  packId: z.string().min(1).max(40).optional(),
  thresholdPaise: z.number().int().min(0).max(10_000_000).optional(),
});
