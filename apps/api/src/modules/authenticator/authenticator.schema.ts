/**
 * Authenticator cloud-backup request DTOs. The ciphertext is an opaque, client-
 * encrypted blob — the server validates only its size, never its contents.
 */
import { z } from 'zod';

// 256 KB ceiling: a passphrase-wrapped vault of realistic size, with slack.
export const putBackupBody = z.object({
  ciphertext: z.string().min(1).max(262_144),
  version: z.number().int().min(1).max(1_000_000).optional(),
});
