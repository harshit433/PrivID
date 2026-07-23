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

/**
 * What the thread screen needs to render its gates: who the other person is,
 * the connection type in both directions, and whether sending is allowed.
 * Messaging permission mirrors calling — allowed unless they blocked you.
 */
export async function context(userId: string, otherUserId: string) {
  const other = await usersRepo.findById(otherUserId);
  if (!other || other.accountStatus !== 'active') throw appError('HANDLE_NOT_FOUND');

  const [mine, theirs, blocked] = await Promise.all([
    connectionsRepo.findEdge(userId, otherUserId),
    connectionsRepo.findEdge(otherUserId, userId),
    connectionsRepo.isBlockedBy(userId, otherUserId),
  ]);

  const myConnectionType = mine?.connectionType ?? 'unknown';
  const theirConnectionType = theirs?.connectionType ?? 'unknown';
  const canSend = !blocked && myConnectionType !== 'blocked';

  return {
    otherUser: {
      userId: other.userId,
      handle: other.handle,
      displayName: other.displayName ?? other.handle,
      avatarUrl: other.avatarUrl,
      trustTier: other.trustTier,
      trustScore: other.trustScore,
    },
    myConnectionType,
    theirConnectionType,
    outgoing: {
      canSend,
      mode: theirConnectionType === 'trusted' ? 'open' : 'limited',
      connectionType: theirConnectionType,
      limit: null,
      used: 0,
      remaining: null,
      code: canSend ? null : 'CHAT_NOT_ALLOWED',
      reason: canSend ? null : 'You can no longer message this person.',
    },
    incoming: {
      isUnknown: myConnectionType === 'unknown',
      theirMessagesUsed: 0,
      theirIntroRemaining: 0,
    },
  };
}

/**
 * Remove a message from a group. Authorisation lives in Stream (it knows the
 * channel roles); we only ensure the caller is a real, active user and that the
 * provider can actually delete. The deletion is hard — a moderated message
 * should not remain fetchable.
 */
export async function deleteMessage(userId: string, messageId: string) {
  const me = await usersRepo.findById(userId);
  if (!me || me.accountStatus !== 'active') throw appError('USER_INACTIVE');

  const stream = getStreamProvider();
  if (typeof stream.deleteMessage !== 'function') {
    throw appError('NOT_CONFIGURED', 'Message deletion is unavailable right now.');
  }
  await stream.deleteMessage(messageId, true);
  logger.info('chat', 'message deleted', { messageId, by: userId });
  return { deleted: true, messageId };
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
