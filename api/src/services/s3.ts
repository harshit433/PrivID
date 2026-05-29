import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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
 * Falls back to returning a data URL if S3 is not configured.
 */
export async function uploadAvatarBuffer(
  userId: string,
  imageBuffer: Buffer,
  contentType: string,
): Promise<string> {
  if (!isS3Configured()) {
    // Fallback: store as data URL in the DB (suitable for dev/testing)
    const b64 = imageBuffer.toString('base64');
    return `data:${contentType};base64,${b64}`;
  }

  const region = process.env.AWS_REGION!;
  const bucket = process.env.AWS_S3_BUCKET!;
  const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
  const key = `avatars/${userId}/${Date.now()}.${ext}`;

  await getS3Client().send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: imageBuffer,
    ContentType: contentType,
  }));

  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}
