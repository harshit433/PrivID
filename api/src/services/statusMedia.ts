/** TrustRoute Status (24h stories) — media limits and S3 helpers. */

export const STATUS_TTL_HOURS = 24;
export const STATUS_MAX_VIDEO_MS = 60_000;
export const STATUS_MAX_TEXT_LEN = 700;
export const STATUS_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const STATUS_MAX_VIDEO_BYTES = 80 * 1024 * 1024;

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);

export function statusBucket(): string {
  return process.env.AWS_S3_STATUS_BUCKET || process.env.AWS_S3_BUCKET || '';
}

export function isStatusS3Configured(): boolean {
  return Boolean(
    process.env.AWS_REGION &&
    statusBucket() &&
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY,
  );
}

export function assertImageContentType(contentType: string): void {
  if (!IMAGE_TYPES.has(contentType)) {
    throw new Error(`Unsupported image type: ${contentType}`);
  }
}

export function assertVideoContentType(contentType: string): void {
  if (!VIDEO_TYPES.has(contentType)) {
    throw new Error(`Unsupported video type: ${contentType}`);
  }
}

export function extensionForContentType(contentType: string): string {
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/webp') return 'webp';
  if (contentType === 'video/quicktime') return 'mov';
  if (contentType === 'video/webm') return 'webm';
  if (contentType === 'video/mp4') return 'mp4';
  return 'jpg';
}

export function publicUrlForKey(key: string): string {
  const region = process.env.AWS_REGION!;
  const bucket = statusBucket();
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}
