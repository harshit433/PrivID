/**
 * Status repository — WhatsApp-style ephemeral updates (24h). The feed is the active
 * updates of the viewer's non-blocked connections. Expiry is enforced in every read
 * (expires_at > now) and hard-purged by the status-expiry worker.
 */
import { db, userStatusUpdates, connections, users, eq, and, ne, gt, sql, desc, inArray } from '@trustroute/core';

export type StatusRow = typeof userStatusUpdates.$inferSelect;

export async function create(input: {
  userId: string;
  type: 'text' | 'image' | 'video';
  textBody?: string | null;
  mediaUrl?: string | null;
  mediaContentType?: string | null;
  durationMs?: number | null;
}): Promise<StatusRow> {
  const [row] = await db
    .insert(userStatusUpdates)
    .values({
      userId: input.userId,
      type: input.type,
      textBody: input.textBody ?? null,
      mediaUrl: input.mediaUrl ?? null,
      mediaContentType: input.mediaContentType ?? null,
      durationMs: input.durationMs ?? null,
    })
    .returning();
  return row!;
}

export async function listActiveForUser(userId: string): Promise<StatusRow[]> {
  return db
    .select()
    .from(userStatusUpdates)
    .where(and(eq(userStatusUpdates.userId, userId), gt(userStatusUpdates.expiresAt, sql`now()`)))
    .orderBy(desc(userStatusUpdates.createdAt));
}

export interface FeedItem {
  statusId: string;
  type: StatusRow['type'];
  textBody: string | null;
  mediaUrl: string | null;
  mediaContentType: string | null;
  durationMs: number | null;
  createdAt: Date;
  expiresAt: Date;
  author: { userId: string; handle: string; displayName: string | null; avatarUrl: string | null };
}

/** Active statuses of the viewer's connections (excluding those the viewer blocked). */
export async function feedForUser(viewerId: string): Promise<FeedItem[]> {
  const contactIds = db
    .select({ id: connections.contactId })
    .from(connections)
    .where(and(eq(connections.ownerId, viewerId), ne(connections.connectionType, 'blocked')));

  return db
    .select({
      statusId: userStatusUpdates.statusId,
      type: userStatusUpdates.type,
      textBody: userStatusUpdates.textBody,
      mediaUrl: userStatusUpdates.mediaUrl,
      mediaContentType: userStatusUpdates.mediaContentType,
      durationMs: userStatusUpdates.durationMs,
      createdAt: userStatusUpdates.createdAt,
      expiresAt: userStatusUpdates.expiresAt,
      author: {
        userId: users.userId,
        handle: users.handle,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      },
    })
    .from(userStatusUpdates)
    .innerJoin(users, eq(users.userId, userStatusUpdates.userId))
    .where(and(inArray(userStatusUpdates.userId, contactIds), gt(userStatusUpdates.expiresAt, sql`now()`)))
    .orderBy(desc(userStatusUpdates.createdAt));
}

export async function remove(userId: string, statusId: string): Promise<boolean> {
  const rows = await db
    .delete(userStatusUpdates)
    .where(and(eq(userStatusUpdates.statusId, statusId), eq(userStatusUpdates.userId, userId)))
    .returning({ id: userStatusUpdates.statusId });
  return rows.length > 0;
}
