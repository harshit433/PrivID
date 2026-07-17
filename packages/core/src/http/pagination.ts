/**
 * Cursor pagination. One contract for every list endpoint: the client passes
 * `?limit=&cursor=`, the server returns `meta: { nextCursor, hasMore }`. Cursors are
 * opaque base64url blobs so the client never constructs them.
 *
 * Typical repository pattern: fetch `limit + 1` rows ordered by (created_at, id);
 * if the extra row exists there is another page. `buildPage` handles the slicing.
 */
import { z } from 'zod';
import type { PageMeta } from './envelope';

export interface CursorPayload {
  /** ISO timestamp of the last item on the page (primary sort key). */
  t: string;
  /** Tie-breaker id of the last item (secondary sort key). */
  id: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined | null): CursorPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (parsed && typeof parsed.t === 'string' && typeof parsed.id === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/** Zod schema fragment for `?limit=&cursor=` query params. Merge into route query schemas. */
export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().optional(),
});

export interface PageInput {
  limit: number;
  cursor?: string;
}

/**
 * Given rows fetched with `limit + 1` and a function to derive a cursor from the
 * last returned row, slice to `limit` and compute the page meta.
 */
export function buildPage<T>(
  rows: T[],
  limit: number,
  toCursor: (row: T) => CursorPayload,
): { items: T[]; meta: PageMeta } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    meta: {
      hasMore,
      nextCursor: hasMore && last ? encodeCursor(toCursor(last)) : null,
    },
  };
}
