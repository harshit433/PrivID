/**
 * Status service: post an ephemeral update, read your own active updates, read the
 * connections feed, and delete an update. Media-by-type consistency mirrors the DB
 * CHECK so the client gets a friendly 400 before the constraint fires.
 */
import { appError } from '@trustroute/core';
import * as repo from './status.repository';
import type { StatusRow, FeedItem } from './status.repository';

function view(s: StatusRow) {
  return {
    statusId: s.statusId,
    type: s.type,
    textBody: s.textBody,
    mediaUrl: s.mediaUrl,
    mediaContentType: s.mediaContentType,
    durationMs: s.durationMs,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
  };
}

export async function post(
  userId: string,
  input: { type: 'text' | 'image' | 'video'; textBody?: string; mediaUrl?: string; mediaContentType?: string; durationMs?: number },
) {
  if (input.type === 'text' && !input.textBody?.trim()) throw appError('BAD_REQUEST', 'Text status needs text.');
  if ((input.type === 'image' || input.type === 'video') && !input.mediaUrl) {
    throw appError('BAD_REQUEST', 'Media status needs a media URL.');
  }
  const s = await repo.create({
    userId,
    type: input.type,
    textBody: input.type === 'text' ? input.textBody ?? null : null,
    mediaUrl: input.type === 'text' ? null : input.mediaUrl ?? null,
    mediaContentType: input.mediaContentType ?? null,
    durationMs: input.durationMs ?? null,
  });
  return view(s);
}

export async function mine(userId: string) {
  return { statuses: (await repo.listActiveForUser(userId)).map(view) };
}

/** Feed grouped by author, so the client renders one ring per contact. */
export async function feed(userId: string) {
  const items = await repo.feedForUser(userId);
  const byAuthor = new Map<string, { author: FeedItem['author']; statuses: Omit<FeedItem, 'author'>[] }>();
  for (const it of items) {
    const key = it.author.userId;
    if (!byAuthor.has(key)) byAuthor.set(key, { author: it.author, statuses: [] });
    const { author: _a, ...rest } = it;
    byAuthor.get(key)!.statuses.push(rest);
  }
  return { feed: [...byAuthor.values()] };
}

export async function remove(userId: string, statusId: string) {
  if (!(await repo.remove(userId, statusId))) throw appError('NOT_FOUND', 'Status not found.');
  return { deleted: true };
}
