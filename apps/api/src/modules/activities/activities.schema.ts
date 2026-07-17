/**
 * Activities request DTOs.
 */
import { z } from 'zod';

const handle = z.string().trim().toLowerCase().regex(/^[a-z0-9._]{3,30}$/);

export const startBody = z
  .object({
    scope: z.enum(['direct', 'group']),
    handle: handle.optional(),
    groupId: z.string().uuid().optional(),
    adapter: z.enum(['youtube', 'screen_share']),
  })
  .refine((b) => (b.scope === 'direct' ? Boolean(b.handle) : Boolean(b.groupId)), {
    message: 'direct needs handle; group needs groupId.',
  });

export const stateBody = z.object({
  state: z.record(z.unknown()),
  baseRevision: z.number().int().min(0),
});

export const presenterBody = z.object({ presenterUserId: z.string().uuid().nullable() });

export const activityIdParam = z.object({ activityId: z.string().uuid() });
