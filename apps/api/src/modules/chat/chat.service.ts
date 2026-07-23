/**
 * Chat service: issue Stream chat tokens, open 1:1 channels (permission-checked), list
 * channels, and process Stream webhooks into the message log. Messaging permission is
 * the same rule as calling: allowed unless the other party has blocked you.
 */
import {
  appError,
  config,
  logger,
  getStreamProvider,
} from '@trustroute/core';
import * as repo from './chat.repository';
import * as usersRepo from '../users/users.repository';
import * as connectionsRepo from '../connections/connections.repository';

async function upsertStreamUser(userId: string) {
  const u = await usersRepo.findById(userId);
  if (u) {
    await getStreamProvider().upsertUser({ id: userId, name: u.displayName ?? u.handle, image: u.avatarUrl ?? undefined });
  }
}

export async function getToken(userId: string) {
  const stream = getStreamProvider();
  await upsertStreamUser(userId);
  return {
    userId,
    token: stream.chatToken(userId),
    apiKey: config.STREAM_API_KEY ?? null,
    provider: stream.configured ? 'stream' : 'mock',
  };
}

export async function openChannel(userId: string, target: { handle?: string; otherUserId?: string }) {
  const other = target.otherUserId
    ? await usersRepo.findById(target.otherUserId)
    : await usersRepo.findByHandle(target.handle!);
  if (!other || other.accountStatus !== 'active') throw appError('HANDLE_NOT_FOUND');
  if (other.userId === userId) throw appError('BAD_REQUEST', 'You cannot message yourself.');
  if (await connectionsRepo.isBlockedBy(userId, other.userId)) throw appError('CHAT_NOT_ALLOWED');

  const channel = await repo.ensureChannel(userId, other.userId);
  const stream = getStreamProvider();
  await Promise.all([upsertStreamUser(userId), upsertStreamUser(other.userId)]);

  return {
    channelCid: channel.channelCid,
    provider: stream.configured ? 'stream' : 'mock',
    counterpart: {
      userId: other.userId,
      handle: other.handle,
      displayName: other.displayName,
      avatarUrl: other.avatarUrl,
      trustTier: other.trustTier,
    },
  };
}

export async function listChannels(userId: string) {
  return { channels: await repo.listChannels(userId) };
}

/**
 * Stream webhook. Verifies the HMAC signature, then records `message.new` events into
 * the audit log and bumps channel recency. Fail-closed on a bad signature.
 */
export async function handleWebhook(rawBody: Buffer | string, signature: string, payload: unknown) {
  const stream = getStreamProvider();
  if (!stream.verifyWebhook(rawBody, signature)) throw appError('FORBIDDEN', 'Invalid webhook signature.');

  const event = payload as {
    type?: string;
    cid?: string;
    message?: { id?: string; user?: { id?: string } };
    members?: Array<{ user_id?: string }>;
  };
  if (event.type !== 'message.new' || !event.cid || !event.message?.id || !event.message.user?.id) {
    return { handled: false };
  }

  // The cid is a hash of the member pair, so the recipient comes from the
  // channel row rather than from splitting the id.
  const senderId = event.message.user.id;
  const channel = await repo.findByCid(event.cid);
  if (!channel) {
    // Group channels have no chat_channels row; nothing to log against.
    logger.debug('chat', 'no 1:1 channel for cid', { cid: event.cid });
    return { handled: true };
  }
  const recipientId = channel.memberLow === senderId ? channel.memberHigh : channel.memberLow;
  if (recipientId && recipientId !== senderId) {
    await repo.logMessage({ messageId: event.message.id, channelCid: event.cid, senderId, recipientId });
    await repo.touchChannel(event.cid);
    logger.debug('chat', 'message logged', { cid: event.cid });
  }
  return { handled: true };
}
