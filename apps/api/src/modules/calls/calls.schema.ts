/**
 * Calls request DTOs.
 */
import { z } from 'zod';
import { paginationQuery } from '@trustroute/core';

const handle = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._]{3,30}$/);

export const initiateBody = z
  .object({
    handle: handle.optional(),
    calleeId: z.string().uuid().optional(),
    callType: z.enum(['direct', 'reachability']).optional(),
    channelId: z.string().uuid().optional(),
  })
  .refine((b) => Boolean(b.handle) || Boolean(b.calleeId), {
    message: 'Provide a handle or calleeId to call.',
  });

export const prepareStreamBody = z
  .object({
    handle: handle.optional(),
    calleeId: z.string().uuid().optional(),
    video: z.boolean().optional(),
  })
  .refine((b) => Boolean(b.handle) || Boolean(b.calleeId), {
    message: 'Provide a handle or calleeId to call.',
    path: ['calleeId'],
  });

export const declineBody = z.object({ reason: z.string().trim().max(120).optional() });

export const qualityBody = z.object({
  mosScore: z.number().min(0).max(5).optional(),
  packetLossPct: z.number().min(0).max(100).optional(),
  jitterMs: z.number().int().min(0).max(100000).optional(),
  rttMs: z.number().int().min(0).max(100000).optional(),
});

export const listQuery = paginationQuery;
export const callIdParam = z.object({ callId: z.string().uuid() });
