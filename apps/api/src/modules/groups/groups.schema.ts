/**
 * Groups request DTOs.
 */
import { z } from 'zod';

const handle = z.string().trim().toLowerCase().regex(/^[a-z0-9._]{3,30}$/);

export const createBody = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  memberHandles: z.array(handle).max(255).optional(),
});

export const updateBody = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(500).nullish(),
    avatarUrl: z.string().url().max(1024).nullish(),
  })
  .strict();

export const addMembersBody = z.object({ handles: z.array(handle).min(1).max(50) });

export const setRoleBody = z.object({
  userId: z.string().uuid(),
  role: z.enum(['admin', 'member']),
});

export const groupIdParam = z.object({ groupId: z.string().uuid() });
export const memberParam = z.object({ groupId: z.string().uuid(), userId: z.string().uuid() });
