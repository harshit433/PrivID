/**
 * Media repository — registry of S3-backed uploads (avatars, status media, chat/group
 * attachments). The row is created in `uploading` state at presign and flipped to
 * `ready` once the client confirms the PUT completed.
 */
import { db, mediaAssets, eq, and, sql } from '@trustroute/core';

export type MediaRow = typeof mediaAssets.$inferSelect;

export async function register(input: {
  mediaRef: string;
  ownerId: string;
  kind: string;
  s3Key: string;
  sizeBytes?: number | null;
  status?: string;
}): Promise<MediaRow> {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      mediaRef: input.mediaRef,
      ownerId: input.ownerId,
      kind: input.kind,
      s3Key: input.s3Key,
      sizeBytes: input.sizeBytes ?? null,
      status: input.status ?? 'uploading',
    })
    .returning();
  return row!;
}

export async function findOwned(ownerId: string, mediaRef: string): Promise<MediaRow | null> {
  const [row] = await db
    .select()
    .from(mediaAssets)
    .where(and(eq(mediaAssets.mediaRef, mediaRef), eq(mediaAssets.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

export async function markReady(ownerId: string, mediaRef: string): Promise<MediaRow | null> {
  const [row] = await db
    .update(mediaAssets)
    .set({ status: 'ready' })
    .where(and(eq(mediaAssets.mediaRef, mediaRef), eq(mediaAssets.ownerId, ownerId)))
    .returning();
  return row ?? null;
}

export async function remove(ownerId: string, mediaRef: string): Promise<MediaRow | null> {
  const [row] = await db
    .delete(mediaAssets)
    .where(and(eq(mediaAssets.mediaRef, mediaRef), eq(mediaAssets.ownerId, ownerId)))
    .returning();
  return row ?? null;
}
