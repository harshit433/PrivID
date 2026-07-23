/**
 * Users request DTOs. Profile fields are optional (PATCH semantics); every string is
 * trimmed and length-bounded to match the DB CHECK constraints.
 */
import { z } from 'zod';

const nullableStr = (max: number) => z.string().trim().max(max).nullish();

export const updateProfileBody = z
  .object({
    displayName: nullableStr(80),
    bio: nullableStr(500),
    profession: nullableStr(120),
    organisation: nullableStr(160),
    businessInfo: nullableStr(500),
    address: nullableStr(300),
    email: z.string().trim().email().max(254).nullish(),
    languagePref: z.string().trim().min(2).max(8).optional(),
  })
  .strict();

export const setAvatarBody = z.object({ avatarUrl: z.string().url().max(1024).nullable() });

export const uploadAvatarBody = z.object({
  imageBase64: z.string().min(1),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']).default('image/jpeg'),
});

export const setStatusBody = z.object({
  statusText: z.string().trim().max(140).nullish(),
  statusEmoji: z.string().trim().max(16).nullish(),
});

export const updateSettingsBody = z
  .object({
    discoveryMode: z.enum(['public', 'private']).optional(),
    discoveryContactBookMatching: z.boolean().optional(),
    discoveryShowTrustScore: z.boolean().optional(),
    notificationPrefs: z.record(z.boolean()).optional(),
    userConsents: z.record(z.union([z.boolean(), z.string()])).optional(),
  })
  .strict();

export const changeHandleBody = z.object({
  handle: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9._]{3,30}$/, 'Handles use 3–30 letters, numbers, dots or underscores.'),
});

export const handleParam = z.object({
  handle: z.string().trim().toLowerCase().regex(/^[a-z0-9._]{3,30}$/),
});

export const discoverQuery = z.object({
  q: z.string().trim().min(1).max(60),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/**
 * Contact matching. The client sends SHA-256 hashes of the phone numbers in
 * its address book — never the numbers themselves — and gets back the accounts
 * that opted into being discoverable.
 */
export const lookupByPhonesBody = z.object({
  phoneHashes: z.array(z.string().trim().regex(/^[a-f0-9]{64}$/i)).min(1).max(500),
});
