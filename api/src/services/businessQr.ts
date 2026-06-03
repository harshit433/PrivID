import crypto from 'crypto';
import { getRedis, keys } from '@trustroute/shared';

const TTL_SECONDS = 60;

export async function issueBusinessQrToken(userId: string): Promise<{ token: string; expires_in: number }> {
  const token = crypto.randomUUID();
  const redis = getRedis();
  await redis.set(keys.bizQr(token), userId, 'EX', TTL_SECONDS);
  return { token, expires_in: TTL_SECONDS };
}
