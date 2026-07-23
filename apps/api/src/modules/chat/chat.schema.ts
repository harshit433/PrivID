/**
 * Chat request DTOs.
 */
import { z } from 'zod';

/**
 * Either identifier opens the channel. The app knows a contact by user id in
 * some entry points and only by @handle in others; requiring `handle` 400'd
 * the former with "handle: required".
 */
export const openChannelBody = z
  .object({
    handle: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9._]{3,30}$/, 'Enter a valid @handle.')
      .optional(),
    otherUserId: z.string().uuid().optional(),
  })
  .refine((b) => Boolean(b.handle || b.otherUserId), {
    message: 'Provide a handle or a user id.',
    path: ['handle'],
  });
