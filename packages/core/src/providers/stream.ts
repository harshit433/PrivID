/**
 * Stream Chat + Video tokens (ported from backend/api stream.ts).
 */
import crypto from 'crypto';
import {StreamChat} from 'stream-chat';
import {config} from '../config';
import {logger} from '../logger';
import type {StreamProvider, StreamUserUpsert} from './types';

const JOB = 'provider:stream';

let client: StreamChat | null = null;

function getClient(): StreamChat {
  if (!client) {
    const apiKey = config.STREAM_API_KEY;
    const apiSecret = config.STREAM_API_SECRET;
    if (!apiKey || !apiSecret) {
      throw new Error('Stream is not configured (STREAM_API_KEY / STREAM_API_SECRET).');
    }
    client = StreamChat.getInstance(apiKey, apiSecret);
    logger.info(JOB, 'Stream client initialised');
  }
  return client;
}

export const streamProvider: StreamProvider = {
  configured: true,

  chatToken(userId: string): string {
    return getClient().createToken(userId);
  },

  videoToken(userId: string): string {
    return getClient().createToken(userId);
  },

  async upsertUser(user: StreamUserUpsert): Promise<void> {
    const sc = getClient();
    await sc.upsertUser({
      id: user.id,
      name: user.name,
      ...(user.image ? {image: user.image} : {}),
    } as Parameters<StreamChat['upsertUser']>[0]);
  },

  verifyWebhook(rawBody: Buffer | string, signature: string): boolean {
    const secret = config.STREAM_API_SECRET;
    if (!secret) return false;
    try {
      const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
      return getClient().verifyWebhook(body, signature);
    } catch {
      const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
      const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
      return expected === signature;
    }
  },
};
