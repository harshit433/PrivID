/**
 * Media service: presign an S3 upload, confirm it, resolve a public URL, delete. The
 * S3 client is behind the storage-provider abstraction, so this runs against the mock
 * (deterministic URLs) with no AWS credentials.
 */
import crypto from 'crypto';
import { appError, getStorageProvider } from '@trustroute/core';
import * as repo from './media.repository';

const KIND_MAX_BYTES: Record<string, number> = {
  avatar: 5 * 1024 * 1024,
  group_avatar: 5 * 1024 * 1024,
  status: 25 * 1024 * 1024,
  chat: 25 * 1024 * 1024,
};

const EXT_BY_CONTENT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
};

export async function presign(userId: string, input: { kind: string; contentType: string; sizeBytes?: number }) {
  const maxBytes = KIND_MAX_BYTES[input.kind];
  if (!maxBytes) throw appError('BAD_REQUEST', 'Unsupported media kind.');
  const ext = EXT_BY_CONTENT[input.contentType];
  if (!ext) throw appError('BAD_REQUEST', 'Unsupported content type.');
  if (input.sizeBytes && input.sizeBytes > maxBytes) throw appError('BAD_REQUEST', 'File is too large.');

  const mediaRef = crypto.randomUUID();
  const s3Key = `media/${input.kind}/${userId}/${mediaRef}.${ext}`;
  const storage = getStorageProvider();
  const presigned = await storage.presignUpload({ key: s3Key, contentType: input.contentType, maxBytes });

  await repo.register({ mediaRef, ownerId: userId, kind: input.kind, s3Key, sizeBytes: input.sizeBytes ?? null });

  return {
    mediaRef,
    uploadUrl: presigned.uploadUrl,
    publicUrl: presigned.publicUrl,
    key: s3Key,
    maxBytes,
    provider: storage.configured ? 's3' : 'mock',
  };
}

export async function confirm(userId: string, mediaRef: string) {
  const row = await repo.markReady(userId, mediaRef);
  if (!row) throw appError('NOT_FOUND', 'Upload not found.');
  return { mediaRef: row.mediaRef, status: row.status, publicUrl: getStorageProvider().publicUrl(row.s3Key) };
}

export async function get(userId: string, mediaRef: string) {
  const row = await repo.findOwned(userId, mediaRef);
  if (!row) throw appError('NOT_FOUND', 'Media not found.');
  return {
    mediaRef: row.mediaRef,
    kind: row.kind,
    status: row.status,
    sizeBytes: row.sizeBytes,
    publicUrl: getStorageProvider().publicUrl(row.s3Key),
    createdAt: row.createdAt,
  };
}

export async function remove(userId: string, mediaRef: string) {
  const row = await repo.remove(userId, mediaRef);
  if (!row) throw appError('NOT_FOUND', 'Media not found.');
  await getStorageProvider().delete(row.s3Key);
  return { deleted: true };
}
