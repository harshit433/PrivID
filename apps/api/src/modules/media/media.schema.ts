/**
 * Media request DTOs.
 */
import { z } from 'zod';

export const presignBody = z.object({
  kind: z.enum(['avatar', 'group_avatar', 'status', 'chat']),
  contentType: z.string().min(3).max(100),
  sizeBytes: z.number().int().min(1).max(50 * 1024 * 1024).optional(),
});

export const mediaRefParam = z.object({ mediaRef: z.string().uuid() });
