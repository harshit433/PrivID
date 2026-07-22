/**
 * S3 object storage with presigned uploads (ported from backend/api s3.ts).
 */
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import {config} from '../config';
import {logger} from '../logger';
import type {StorageProvider} from './types';

const JOB = 'provider:s3';

let client: S3Client | null = null;

function bucket(): string {
  const b = config.S3_BUCKET ?? config.AWS_S3_BUCKET;
  if (!b) throw new Error('S3 bucket is not configured (S3_BUCKET).');
  return b;
}

function getClient(): S3Client {
  if (!client) {
    const region = config.AWS_REGION;
    const accessKeyId = config.AWS_ACCESS_KEY_ID;
    const secretAccessKey = config.AWS_SECRET_ACCESS_KEY;
    if (!region || !accessKeyId || !secretAccessKey) {
      throw new Error('AWS credentials are not configured.');
    }
    client = new S3Client({
      region,
      credentials: {accessKeyId, secretAccessKey},
    });
    logger.info(JOB, 'S3 client initialised', {region, bucket: bucket()});
  }
  return client;
}

function objectPublicUrl(key: string): string {
  if (config.S3_PUBLIC_BASE_URL) {
    return `${config.S3_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`;
  }
  const region = config.AWS_REGION!;
  return `https://${bucket()}.s3.${region}.amazonaws.com/${key}`;
}

export const s3StorageProvider: StorageProvider = {
  configured: true,

  async presignUpload(input) {
    const cmd = new PutObjectCommand({
      Bucket: bucket(),
      Key: input.key,
      ContentType: input.contentType,
    });
    const uploadUrl = await getSignedUrl(getClient(), cmd, {expiresIn: 600});
    return {
      uploadUrl,
      key: input.key,
      publicUrl: objectPublicUrl(input.key),
    };
  },

  async putObject(input) {
    await getClient().send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
      }),
    );
    return { publicUrl: objectPublicUrl(input.key) };
  },

  publicUrl(key: string): string {
    return objectPublicUrl(key);
  },

  async delete(key: string): Promise<void> {
    await getClient().send(new DeleteObjectCommand({Bucket: bucket(), Key: key}));
  },
};
