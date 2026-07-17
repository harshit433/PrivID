/**
 * Connections repository — the directed address-book + reachability edge. One
 * `connection_type` per (owner → contact) governs both call and message permission.
 * Lists join the contact's public profile and paginate by (created_at, connection_id).
 */
import {
  db,
  connections,
  users,
  eq,
  and,
  or,
  lt,
  sql,
  desc,
} from '@trustroute/core';

export type ConnectionRow = typeof connections.$inferSelect;

export interface ConnectionWithContact {
  connectionId: string;
  connectionType: ConnectionRow['connectionType'];
  contactName: string | null;
  notes: string | null;
  dailyCallLimit: number | null;
  temporaryExpiresAt: Date | null;
  createdAt: Date;
  contact: {
    userId: string;
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
    trustTier: (typeof users.$inferSelect)['trustTier'];
    trustScore: number | null;
  };
}

const contactSelection = {
  connectionId: connections.connectionId,
  connectionType: connections.connectionType,
  contactName: connections.contactName,
  notes: connections.notes,
  dailyCallLimit: connections.dailyCallLimit,
  temporaryExpiresAt: connections.temporaryExpiresAt,
  createdAt: connections.createdAt,
  contact: {
    userId: users.userId,
    handle: users.handle,
    displayName: users.displayName,
    avatarUrl: users.avatarUrl,
    trustTier: users.trustTier,
    trustScore: sql<number | null>`CASE WHEN ${users.discoveryShowTrustScore} THEN ${users.trustScore} ELSE NULL END`,
  },
} as const;

/** One page of the owner's connections, newest first, keyset-paginated. */
export async function listByOwner(
  ownerId: string,
  limit: number,
  cursor: { t: string; id: string } | null,
): Promise<ConnectionWithContact[]> {
  const where = cursor
    ? and(
        eq(connections.ownerId, ownerId),
        or(
          lt(connections.createdAt, new Date(cursor.t)),
          and(eq(connections.createdAt, new Date(cursor.t)), lt(connections.connectionId, cursor.id)),
        ),
      )
    : eq(connections.ownerId, ownerId);

  return db
    .select(contactSelection)
    .from(connections)
    .innerJoin(users, eq(users.userId, connections.contactId))
    .where(where)
    .orderBy(desc(connections.createdAt), desc(connections.connectionId))
    .limit(limit + 1);
}

export async function findEdge(ownerId: string, contactId: string): Promise<ConnectionRow | null> {
  const [row] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.ownerId, ownerId), eq(connections.contactId, contactId)))
    .limit(1);
  return row ?? null;
}

export async function getWithContact(ownerId: string, contactId: string): Promise<ConnectionWithContact | null> {
  const [row] = await db
    .select(contactSelection)
    .from(connections)
    .innerJoin(users, eq(users.userId, connections.contactId))
    .where(and(eq(connections.ownerId, ownerId), eq(connections.contactId, contactId)))
    .limit(1);
  return row ?? null;
}

export interface UpsertInput {
  connectionType?: ConnectionRow['connectionType'];
  contactName?: string | null;
  notes?: string | null;
  dailyCallLimit?: number | null;
  temporaryExpiresAt?: Date | null;
}

/** Create the edge, or update it if it already exists (idempotent "add contact"). */
export async function upsert(ownerId: string, contactId: string, input: UpsertInput): Promise<ConnectionRow> {
  const [row] = await db
    .insert(connections)
    .values({
      ownerId,
      contactId,
      connectionType: input.connectionType ?? 'unknown',
      contactName: input.contactName ?? null,
      notes: input.notes ?? null,
      dailyCallLimit: input.dailyCallLimit ?? null,
      temporaryExpiresAt: input.temporaryExpiresAt ?? null,
    })
    .onConflictDoUpdate({
      target: [connections.ownerId, connections.contactId],
      set: {
        connectionType: sql`COALESCE(EXCLUDED.connection_type, ${connections.connectionType})`,
        contactName: sql`COALESCE(EXCLUDED.contact_name, ${connections.contactName})`,
        notes: sql`COALESCE(EXCLUDED.notes, ${connections.notes})`,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return row!;
}

export async function update(ownerId: string, contactId: string, input: UpsertInput): Promise<ConnectionRow | null> {
  const set: Record<string, unknown> = { updatedAt: sql`now()` };
  if (input.connectionType !== undefined) set.connectionType = input.connectionType;
  if (input.contactName !== undefined) set.contactName = input.contactName;
  if (input.notes !== undefined) set.notes = input.notes;
  if (input.dailyCallLimit !== undefined) set.dailyCallLimit = input.dailyCallLimit;
  if (input.temporaryExpiresAt !== undefined) set.temporaryExpiresAt = input.temporaryExpiresAt;
  const [row] = await db
    .update(connections)
    .set(set)
    .where(and(eq(connections.ownerId, ownerId), eq(connections.contactId, contactId)))
    .returning();
  return row ?? null;
}

export async function setType(
  ownerId: string,
  contactId: string,
  type: ConnectionRow['connectionType'],
): Promise<ConnectionRow | null> {
  const [row] = await db
    .update(connections)
    .set({ connectionType: type, updatedAt: sql`now()` })
    .where(and(eq(connections.ownerId, ownerId), eq(connections.contactId, contactId)))
    .returning();
  return row ?? null;
}

export async function remove(ownerId: string, contactId: string): Promise<boolean> {
  const rows = await db
    .delete(connections)
    .where(and(eq(connections.ownerId, ownerId), eq(connections.contactId, contactId)))
    .returning({ id: connections.connectionId });
  return rows.length > 0;
}

/** Does the contact block the owner? (reverse edge with type=blocked) */
export async function isBlockedBy(ownerId: string, contactId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: connections.connectionId })
    .from(connections)
    .where(
      and(
        eq(connections.ownerId, contactId),
        eq(connections.contactId, ownerId),
        eq(connections.connectionType, 'blocked'),
      ),
    )
    .limit(1);
  return Boolean(row);
}
