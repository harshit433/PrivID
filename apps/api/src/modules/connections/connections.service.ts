/**
 * Connections service: add/list/update/remove contacts and block/unblock. Contacts are
 * added by @handle (resolved to a user id here); the DB stores the user-id edge.
 */
import { appError, buildPage, decodeCursor, type PageMeta } from '@trustroute/core';
import * as repo from './connections.repository';
import type { ConnectionWithContact } from './connections.repository';
import * as usersRepo from '../users/users.repository';

async function resolveContact(handle: string, selfId: string): Promise<string> {
  const contact = await usersRepo.findByHandle(handle);
  if (!contact || contact.accountStatus !== 'active') throw appError('HANDLE_NOT_FOUND');
  if (contact.userId === selfId) throw appError('BAD_REQUEST', 'You cannot add yourself as a connection.');
  return contact.userId;
}

export async function list(
  ownerId: string,
  limit: number,
  cursor?: string,
): Promise<{ items: ConnectionWithContact[]; meta: PageMeta }> {
  const rows = await repo.listByOwner(ownerId, limit, decodeCursor(cursor));
  return buildPage(rows, limit, (r) => ({ t: r.createdAt.toISOString(), id: r.connectionId }));
}

export async function add(
  ownerId: string,
  input: { handle: string; connectionType?: 'unknown' | 'temporary' | 'trusted'; contactName?: string; notes?: string; temporaryHours?: number },
) {
  const contactId = await resolveContact(input.handle, ownerId);
  const temporaryExpiresAt =
    input.connectionType === 'temporary' && input.temporaryHours
      ? new Date(Date.now() + input.temporaryHours * 3_600_000)
      : null;
  await repo.upsert(ownerId, contactId, {
    connectionType: input.connectionType,
    contactName: input.contactName ?? null,
    notes: input.notes ?? null,
    temporaryExpiresAt,
  });
  const full = await repo.getWithContact(ownerId, contactId);
  return full!;
}

export async function get(ownerId: string, contactId: string) {
  const row = await repo.getWithContact(ownerId, contactId);
  if (!row) throw appError('NOT_FOUND', 'Connection not found.');
  return row;
}

export async function update(
  ownerId: string,
  contactId: string,
  patch: repo.UpsertInput,
) {
  const updated = await repo.update(ownerId, contactId, patch);
  if (!updated) throw appError('NOT_FOUND', 'Connection not found.');
  return (await repo.getWithContact(ownerId, contactId))!;
}

export async function remove(ownerId: string, contactId: string) {
  const ok = await repo.remove(ownerId, contactId);
  if (!ok) throw appError('NOT_FOUND', 'Connection not found.');
  return { removed: true };
}

/** Block a user by handle — creates/updates the owner→target edge to `blocked`. */
export async function block(ownerId: string, handle: string) {
  const contactId = await resolveContact(handle, ownerId);
  await repo.upsert(ownerId, contactId, {});
  await repo.setType(ownerId, contactId, 'blocked');
  return { blocked: true, contactId };
}

export async function unblock(ownerId: string, contactId: string) {
  const edge = await repo.findEdge(ownerId, contactId);
  if (!edge || edge.connectionType !== 'blocked') throw appError('NOT_FOUND', 'No block to remove.');
  await repo.setType(ownerId, contactId, 'unknown');
  return { unblocked: true };
}
