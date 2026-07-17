/**
 * Connections are the directed reachability + address-book relationship. One
 * `connection_type` governs BOTH calling and messaging permissions — never duplicated.
 */
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { connectionType } from './_enums';
import { createdAt, updatedAt, ts } from './_helpers';
import { users } from './users';

export const connections = pgTable(
  'connections',
  {
    connectionId: uuid('connection_id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    connectionType: connectionType('connection_type').notNull().default('unknown'),
    temporaryExpiresAt: ts('temporary_expires_at'),
    dailyCallLimit: integer('daily_call_limit'),
    contactName: text('contact_name'),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('uq_connections_owner_contact').on(t.ownerId, t.contactId),
    index('idx_connections_owner').on(t.ownerId),
    index('idx_connections_contact').on(t.contactId),
    index('idx_connections_owner_contact_type').on(t.ownerId, t.contactId, t.connectionType),
  ],
);
