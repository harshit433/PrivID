/**
 * Groups service: create/list/get groups, membership + role management, leave/delete.
 * Admin-only mutations are enforced here; "shared content" survives creator deletion
 * (the group persists for remaining members).
 */
import crypto from 'crypto';
import { appError } from '@trustroute/core';
import * as repo from './groups.repository';
import type { GroupRow } from './groups.repository';
import * as usersRepo from '../users/users.repository';

const MAX_MEMBERS = 256;

function groupView(g: GroupRow) {
  return {
    groupId: g.groupId,
    channelCid: g.channelCid,
    name: g.name,
    description: g.description,
    avatarUrl: g.avatarUrl,
    createdBy: g.createdBy,
    createdAt: g.createdAt,
  };
}

async function requireMember(groupId: string, userId: string) {
  const m = await repo.membership(groupId, userId);
  if (!m) throw appError('FORBIDDEN', 'You are not a member of this group.');
  return m;
}

async function requireAdmin(groupId: string, userId: string) {
  const m = await requireMember(groupId, userId);
  if (m.role !== 'admin') throw appError('FORBIDDEN', 'Only group admins can do that.');
  return m;
}

/** Resolve @handles to active user ids, skipping unknown/self. */
async function resolveHandles(handles: string[], selfId: string): Promise<string[]> {
  const ids: string[] = [];
  for (const h of handles) {
    const u = await usersRepo.findByHandle(h);
    if (u && u.accountStatus === 'active' && u.userId !== selfId) ids.push(u.userId);
  }
  return [...new Set(ids)];
}

export async function create(userId: string, input: { name: string; description?: string; memberHandles?: string[] }) {
  const channelCid = `messaging:group-${crypto.randomUUID()}`;
  const group = await repo.createGroup({
    channelCid,
    name: input.name.trim(),
    description: input.description ?? null,
    createdBy: userId,
  });
  const memberIds = await resolveHandles(input.memberHandles ?? [], userId);
  if (memberIds.length + 1 > MAX_MEMBERS) throw appError('BAD_REQUEST', 'Too many members.');
  await repo.addMembers(group.groupId, [
    { userId, role: 'admin' },
    ...memberIds.map((id) => ({ userId: id, role: 'member' as const })),
  ]);
  return { ...groupView(group), memberCount: memberIds.length + 1, role: 'admin' };
}

export async function list(userId: string) {
  const groups = await repo.listForUser(userId);
  return { groups: groups.map((g) => ({ ...groupView(g), memberCount: g.memberCount, role: g.role })) };
}

export async function get(userId: string, groupId: string) {
  await requireMember(groupId, userId);
  const group = await repo.findGroup(groupId);
  if (!group) throw appError('NOT_FOUND', 'Group not found.');
  const members = await repo.listMembers(groupId);
  return { ...groupView(group), members };
}

export async function update(
  userId: string,
  groupId: string,
  patch: { name?: string; description?: string | null; avatarUrl?: string | null },
) {
  await requireAdmin(groupId, userId);
  const updated = await repo.updateGroup(groupId, patch);
  return groupView(updated);
}

export async function addMembers(userId: string, groupId: string, handles: string[]) {
  await requireAdmin(groupId, userId);
  const ids = await resolveHandles(handles, userId);
  if ((await repo.countMembers(groupId)) + ids.length > MAX_MEMBERS) throw appError('BAD_REQUEST', 'Too many members.');
  await repo.addMembers(groupId, ids.map((id) => ({ userId: id, role: 'member' as const })));
  return { added: ids.length };
}

export async function setRole(userId: string, groupId: string, targetUserId: string, role: 'admin' | 'member') {
  await requireAdmin(groupId, userId);
  if (!(await repo.membership(groupId, targetUserId))) throw appError('NOT_FOUND', 'That user is not in the group.');
  // Don't allow removing the last admin via demotion.
  if (role === 'member' && (await repo.countAdmins(groupId)) <= 1) {
    throw appError('CONFLICT', 'A group must keep at least one admin.');
  }
  await repo.setRole(groupId, targetUserId, role);
  return { updated: true };
}

export async function removeMember(userId: string, groupId: string, targetUserId: string) {
  await requireAdmin(groupId, userId);
  if (targetUserId === userId) throw appError('BAD_REQUEST', 'Use leave to remove yourself.');
  await repo.removeMember(groupId, targetUserId);
  return { removed: true };
}

/** Leave a group. Deletes the group if the last member leaves; blocks the last admin
 * from orphaning it while others remain. */
export async function leave(userId: string, groupId: string) {
  const m = await requireMember(groupId, userId);
  const total = await repo.countMembers(groupId);
  if (total === 1) {
    await repo.deleteGroup(groupId);
    return { left: true, groupDeleted: true };
  }
  if (m.role === 'admin' && (await repo.countAdmins(groupId)) === 1) {
    throw appError('CONFLICT', 'Promote another admin before leaving.');
  }
  await repo.removeMember(groupId, userId);
  return { left: true, groupDeleted: false };
}

export async function remove(userId: string, groupId: string) {
  const group = await repo.findGroup(groupId);
  if (!group) throw appError('NOT_FOUND', 'Group not found.');
  await requireAdmin(groupId, userId);
  await repo.deleteGroup(groupId);
  return { deleted: true };
}
