/**
 * Reachability request DTOs.
 */
import { z } from 'zod';

export const createChannelBody = z.object({
  label: z.string().trim().max(80).optional(),
  dailyLimit: z.number().int().min(1).max(100).optional(),
  totalLimit: z.number().int().min(1).max(100000).optional(),
  expiresInHours: z.number().int().min(1).max(24 * 365).optional(),
});

export const createShareBody = z.object({
  type: z.enum(['permanent', 'disposable']),
  label: z.string().trim().max(80).optional(),
  expiresInHours: z.number().int().min(1).max(24 * 365).optional(),
  maxUses: z.number().int().min(1).max(10000).optional(),
});

export const resolveBody = z.object({
  token: z.string().min(8).max(256),
  deviceHash: z.string().max(256).optional(),
});

export const channelIdParam = z.object({ channelId: z.string().uuid() });
export const shareIdParam = z.object({ shareId: z.string().uuid() });
