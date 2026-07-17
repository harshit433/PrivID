/**
 * Chat request DTOs.
 */
import { z } from 'zod';

export const openChannelBody = z.object({
  handle: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9._]{3,30}$/, 'Enter a valid @handle.'),
});
