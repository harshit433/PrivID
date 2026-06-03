import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  assertImageContentType,
  assertVideoContentType,
  extensionForContentType,
  isStatusS3Configured,
  publicUrlForKey,
  STATUS_MAX_IMAGE_BYTES,
  STATUS_TTL_HOURS,
  statusBucket,
} from './statusMedia';

function isS3Configured(): boolean {
  return Boolean(
    process.env.AWS_REGION &&
    process.env.AWS_S3_BUCKET &&
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY
  );
}

function getS3Client(): S3Client {
  return new S3Client({
    region: process.env.AWS_REGION!,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
}

export async function generateAvatarUploadUrl(
  userId: string,
  contentType: string,
): Promise<{ uploadUrl: string; publicUrl: string }> {
  if (!isS3Configured()) {
    throw new Error('S3 not configured — use uploadAvatarDirect instead.');
  }
  const region = process.env.AWS_REGION!;
  const bucket = process.env.AWS_S3_BUCKET!;
  const key = `avatars/${userId}/${Date.now()}.jpg`;

  const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType });
  const uploadUrl = await getSignedUrl(getS3Client(), command, { expiresIn: 300 });
  const publicUrl = `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
  return { uploadUrl, publicUrl };
}

/**
 * Upload image Buffer directly to S3 (server-side, no presigned URL needed).
 * Falls back to a data URL if S3 is not configured OR if the upload fails,
 * so photo upload always works regardless of cloud storage setup.
 */
export async function uploadAvatarBuffer(
  userId: string,
  imageBuffer: Buffer,
  contentType: string,
): Promise<string> {
  if (isS3Configured()) {
    const region = process.env.AWS_REGION!;
    const bucket = process.env.AWS_S3_BUCKET!;
    const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
    const key = `avatars/${userId}/${Date.now()}.${ext}`;

    try {
      await getS3Client().send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: imageBuffer,
        ContentType: contentType,
      }));
      return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
    } catch (s3Err) {
      // Log but don't surface to client — fall through to data URL fallback
      console.warn('[S3] Avatar upload failed, using data URL fallback:', (s3Err as Error).message);
    }
  }

  // Fallback: store as inline data URL.
  // Works fine in dev / when S3 isn't configured or fails.
  const b64 = imageBuffer.toString('base64');
  return `data:${contentType};base64,${b64}`;
}

function statusKey(userId: string, contentType: string): string {
  const ext = extensionForContentType(contentType);
  return `status/${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
}

export async function generateStatusUploadUrl(
  userId: string,
  contentType: string,
  kind: 'image' | 'video',
): Promise<{ uploadUrl: string; publicUrl: string; key: string }> {
  if (!isStatusS3Configured()) {
    throw new Error('Status media S3 is not configured.');
  }
  if (kind === 'image') assertImageContentType(contentType);
  else assertVideoContentType(contentType);

  const bucket = statusBucket();
  const key = statusKey(userId, contentType);
  const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType });
  const uploadUrl = await getSignedUrl(getS3Client(), command, { expiresIn: 600 });
  return { uploadUrl, publicUrl: publicUrlForKey(key), key };
}

export async function uploadStatusImageBuffer(
  userId: string,
  imageBuffer: Buffer,
  contentType: string,
): Promise<string> {
  assertImageContentType(contentType);
  if (imageBuffer.length < 50 || imageBuffer.length > STATUS_MAX_IMAGE_BYTES) {
    throw new Error(`Image must be between 50 bytes and ${STATUS_MAX_IMAGE_BYTES} bytes.`);
  }
  if (!isStatusS3Configured()) {
    const b64 = imageBuffer.toString('base64');
    return `data:${contentType};base64,${b64}`;
  }
  const bucket = statusBucket();
  const key = statusKey(userId, contentType);
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: imageBuffer,
      ContentType: contentType,
    }),
  );
  return publicUrlForKey(key);
}

/** Extract S3 object key from a stored status media URL. */
export function parseStatusObjectKey(mediaUrl: string): string | null {
  if (!mediaUrl.startsWith('http')) return null;
  const bucket = statusBucket();
  const region = process.env.AWS_REGION!;
  const virtualHosted = `https://${bucket}.s3.${region}.amazonaws.com/`;
  if (mediaUrl.startsWith(virtualHosted)) {
    return decodeURIComponent(mediaUrl.slice(virtualHosted.length).split('?')[0]);
  }
  const pathStyle = `https://s3.${region}.amazonaws.com/${bucket}/`;
  if (mediaUrl.startsWith(pathStyle)) {
    return decodeURIComponent(mediaUrl.slice(pathStyle.length).split('?')[0]);
  }
  return null;
}

/**
 * Return a URL the mobile app can load. Private status buckets need presigned GET URLs.
 */
export async function resolveStatusMediaUrl(mediaUrl: string | null): Promise<string | null> {
  if (!mediaUrl) return null;
  if (mediaUrl.startsWith('data:')) return mediaUrl;
  if (!isStatusS3Configured()) return mediaUrl;

  const key = parseStatusObjectKey(mediaUrl);
  if (!key?.startsWith('status/')) return mediaUrl;

  const command = new GetObjectCommand({ Bucket: statusBucket(), Key: key });
  return getSignedUrl(getS3Client(), command, {
    expiresIn: STATUS_TTL_HOURS * 3600,
  });
}

export async function deleteStatusMediaByUrl(mediaUrl: string): Promise<void> {
  if (!isStatusS3Configured() || !mediaUrl.startsWith('http')) return;
  try {
    const key = parseStatusObjectKey(mediaUrl);
    if (!key?.startsWith('status/')) return;
    await getS3Client().send(new DeleteObjectCommand({ Bucket: statusBucket(), Key: key }));
  } catch (err) {
    console.warn('[S3] Status media delete failed:', (err as Error).message);
  }
}
