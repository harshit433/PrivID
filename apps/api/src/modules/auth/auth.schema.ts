import { z } from 'zod';

export const handleSchema = z
  .string()
  .trim()
  .transform((h) => h.replace(/^@/, '').toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9._]{3,30}$/, 'Handles can use letters, numbers, dots and underscores.'));

export const pinSchema = z.string().regex(/^\d{6}$/, 'PIN must be 6 digits.');

export const checkHandleBody = z.object({ handle: handleSchema });

export const loginBody = z.object({
  handle: handleSchema,
  pin: pinSchema,
  deviceId: z.string().max(128).optional(),
});

export const refreshBody = z.object({
  refresh_token: z.string().min(20),
});

export const setPinBody = z.object({
  pin: pinSchema,
});
