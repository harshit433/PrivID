/**
 * Status request DTOs. Media-by-type is refined so a text status can't carry media
 * and vice-versa (also enforced by a DB CHECK).
 */
import { z } from 'zod';

export const postBody = z
  .object({
    type: z.enum(['text', 'image', 'video']),
    textBody: z.string().trim().min(1).max(700).optional(),
    mediaUrl: z.string().url().max(2048).optional(),
    mediaContentType: z.string().max(100).optional(),
    durationMs: z.number().int().min(1).max(60000).optional(),
  })
  .refine((b) => (b.type === 'text' ? Boolean(b.textBody) : Boolean(b.mediaUrl)), {
    message: 'Text status needs textBody; image/video needs mediaUrl.',
  });

export const statusIdParam = z.object({ statusId: z.string().uuid() });
