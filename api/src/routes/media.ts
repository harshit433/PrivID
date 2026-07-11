import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { query, queryOne } from '@trustroute/shared';

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_DOC_BYTES = 25 * 1024 * 1024;

function isS3Configured(): boolean {
  return Boolean(
    process.env.AWS_REGION &&
    process.env.AWS_S3_BUCKET &&
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY,
  );
}

let s3Client: import('@aws-sdk/client-s3').S3Client | null = null;
function getS3() {
  if (!s3Client) {
    const { S3Client } = require('@aws-sdk/client-s3') as typeof import('@aws-sdk/client-s3');
    s3Client = new S3Client({
      region: process.env.AWS_REGION!,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    });
  }
  return s3Client!;
}

export const mediaRouter = Router();
mediaRouter.use(requireAuth);

const presignSchema = z.object({
  kind: z.enum(['image', 'video', 'audio', 'doc']),
  content_type: z.string().min(3).max(100),
  size_bytes: z.number().int().positive(),
  conv_id: z.string().uuid().optional(),
});

mediaRouter.post('/presign', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isS3Configured()) {
      throw new AppError(503, 'MEDIA_UNAVAILABLE', 'Media uploads are briefly unavailable.');
    }
    const body = presignSchema.parse(req.body);
    const limits: Record<string, number> = {
      image: MAX_IMAGE_BYTES,
      video: MAX_VIDEO_BYTES,
      audio: MAX_DOC_BYTES,
      doc: MAX_DOC_BYTES,
    };
    if (body.size_bytes > limits[body.kind]!) {
      throw new AppError(400, 'FILE_TOO_LARGE', `File too large (max ${Math.floor(limits[body.kind]! / 1024 / 1024)} MB).`);
    }

    const mediaRef = crypto.randomUUID();
    const ext = body.content_type.split('/')[1]?.split('+')[0] ?? 'bin';
    const key = `chat/${req.user!.sub}/${mediaRef}.${ext}`;

    const uploadUrl = await getSignedUrl(
      getS3(),
      new PutObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET!,
        Key: key,
        ContentType: body.content_type,
      }),
      { expiresIn: 600 },
    );

    const downloadUrl = await getSignedUrl(
      getS3(),
      new GetObjectCommand({ Bucket: process.env.AWS_S3_BUCKET!, Key: key }),
      { expiresIn: 3600 },
    );

    await query(
      `INSERT INTO media_assets (media_ref, owner_id, conv_id, kind, size_bytes, s3_key, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [mediaRef, req.user!.sub, body.conv_id ?? null, body.kind, body.size_bytes, key],
    );

    res.json({
      ok: true,
      data: {
        media_ref: mediaRef,
        upload_url: uploadUrl,
        download_url: downloadUrl,
        expires_in: 600,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0]!.message));
    }
    next(err);
  }
});

mediaRouter.get('/:ref/url', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isS3Configured()) throw new AppError(503, 'MEDIA_UNAVAILABLE', 'Media unavailable.');
    const asset = await queryOne<{ s3_key: string; owner_id: string }>(
      `SELECT s3_key, owner_id FROM media_assets WHERE media_ref = $1`,
      [req.params.ref],
    );
    if (!asset) throw new AppError(404, 'NOT_FOUND', 'Media not found.');
    const url = await getSignedUrl(
      getS3(),
      new GetObjectCommand({ Bucket: process.env.AWS_S3_BUCKET!, Key: asset.s3_key }),
      { expiresIn: 3600 },
    );
    res.json({ ok: true, data: { url } });
  } catch (err) {
    next(err);
  }
});
