/**
 * Groups repository. Group chat lives in Stream; here we mirror membership + roles so
 * the server can authorize admin actions (rename, add/remove, delete) independently.
 */
import { db, groupChannels, groupMembers, users, eq, and, sql, desc } from '@trustroute/core';

export type GroupRow = typeof groupChannels.$inferSelect;
export type MemberRow = typeof groupMembers.$inferSelect;

export async function createGroup(input: {
  channelCid: string;
  name: string;
  description?: string | null;
  createdBy: string;
}): Promise<GroupRow> {
  const [row] = await db
    .insert(groupChannels)
    .values({
      channelCid: input.channelCid,
      name: input.name,
      description: input.description ?? null,
      createdBy: input.createdBy,
    })
    .returning();
  return row!;
}

export async function addMembers(groupId: string, entries: Array<{ userId: string; role?: 'admin' | 'member' }>): Promise<void> {
  if (entries.length === 0) return;
  await db
    .insert(groupMembers)
    .values(entries.map((e) => ({ groupId, userId: e.userId, role: e.role ?? 'member' })))
    .onConflictDoNothing({ target: [groupMembers.groupId, groupMembers.userId] });
}

export async function findGroup(groupId: string): Promise<GroupRow | null> {
  const [row] = await db.select().from(groupChannels).where(eq(groupChannels.groupId, groupId)).limit(1);
  return row ?? null;
}

export async function membership(groupId: string, userId: string): Promise<MemberRow | null> {
  const [row] = await db
    .select()
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function listForUser(userId: string): Promise<Array<GroupRow & { role: string; memberCount: number }>> {
  return db
    .select({
      groupId: groupChannels.groupId,
      channelCid: groupChannels.channelCid,
      name: groupChannels.name,
      description: groupChannels.description,
      avatarUrl: groupChannels.avatarUrl,
      createdBy: groupChannels.createdBy,
      createdAt: groupChannels.createdAt,
      updatedAt: groupChannels.updatedAt,
      role: groupMembers.role,
      memberCount: sql<number>`(SELECT count(*)::int FROM group_members gm WHERE gm.group_id = ${groupChannels.groupId})`,
    })
    .from(groupMembers)
    .innerJoin(groupChannels, eq(groupChannels.groupId, groupMembers.groupId))
    .where(eq(groupMembers.userId, userId))
    .orderBy(desc(groupChannels.updatedAt));
}

export interface GroupMemberView {
  userId: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: string;
  joinedAt: Date;
}

export async function listMembers(groupId: string): Promise<GroupMemberView[]> {
  return db
    .select({
      userId: users.userId,
      handle: users.handle,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      role: groupMembers.role,
      joinedAt: groupMembers.joinedAt,
    })
    .from(groupMembers)
    .innerJoin(users, eq(users.userId, groupMembers.userId))
    .where(eq(groupMembers.groupId, groupId))
    .orderBy(desc(groupMembers.role), users.handle);
}

export async function updateGroup(
  groupId: string,
  patch: { name?: string; description?: string | null; avatarUrl?: string | null },
): Promise<GroupRow> {
  const [row] = await db
    .update(groupChannels)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(groupChannels.groupId, groupId))
    .returning();
  return row!;
}

export async function setRole(groupId: string, userId: string, role: 'admin' | 'member'): Promise<void> {
  await db
    .update(groupMembers)
    .set({ role })
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)));
}

export async function removeMember(groupId: string, userId: string): Promise<void> {
  await db.delete(groupMembers).where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)));
}

export async function countMembers(groupId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(groupMembers)
    .where(eq(groupMembers.groupId, groupId));
  return row?.n ?? 0;
}

export async function countAdmins(groupId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.role, 'admin')));
  return row?.n ?? 0;
}

export async function deleteGroup(groupId: string): Promise<void> {
  await db.delete(groupChannels).where(eq(groupChannels.groupId, groupId)); // members cascade
}
