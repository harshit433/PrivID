/**
 * Authenticator cloud backup (Phase 2). Stores the user's TOTP vault as one opaque,
 * passphrase-encrypted blob, keyed to the durable `identity_id` so it survives
 * device / SIM / handle changes (the differentiator vs Google Authenticator).
 *
 * The server stores CIPHERTEXT ONLY — seeds are encrypted on-device with a key
 * derived from the user's passphrase; the plaintext never reaches here. One backup
 * per identity (the identity_id is the primary key → upsert).
 */
import { pgTable, uuid, text, integer } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt } from './_helpers';
import { identities } from './identity';

export const authenticatorBackups = pgTable('authenticator_backups', {
  identityId: uuid('identity_id')
    .primaryKey()
    .references(() => identities.identityId, { onDelete: 'cascade' }),
  ciphertext: text('ciphertext').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
