import type Redis from 'ioredis';
import { getRedis } from '@trustroute/shared';
import { logger } from '../utils/logger';

const CONV_PATTERN = 'chat:conv:*';
const USER_PATTERN = 'chat:user:*';

export type ChatWsEvent =
  | { type: 'message.new'; conv_id: string; message: unknown }
  | { type: 'message.status'; conv_id: string; msg_id: string; user_id: string; state: 'delivered' | 'read' }
  | { type: 'typing'; conv_id: string; user_id: string; is_typing: boolean }
  | { type: 'inbox.update'; conv_id: string }
  | { type: 'reaction'; conv_id: string; msg_id: string; user_id: string; emoji?: string | null; action?: 'add' | 'remove' };

let subscriber: Redis | null = null;
const handlers = new Set<(event: ChatWsEvent) => void>();

function dispatch(raw: string): void {
  try {
    const event = JSON.parse(raw) as ChatWsEvent;
    for (const h of handlers) h(event);
  } catch (e) {
    logger.warn('chatPubSub', 'Invalid pub/sub payload: ' + String(e));
  }
}

export async function initChatPubSub(onEvent: (event: ChatWsEvent) => void): Promise<void> {
  handlers.add(onEvent);
  if (subscriber) return;

  try {
    const redis = getRedis();
    subscriber = redis.duplicate();
    if (subscriber.status === 'wait' || subscriber.status === 'end') {
      await subscriber.connect();
    }
    await subscriber.psubscribe(CONV_PATTERN, USER_PATTERN);
    subscriber.on('pmessage', (_pattern, _channel, message) => {
      dispatch(message);
    });
    logger.debug('chatPubSub', 'Subscribed to chat channels');
  } catch (e) {
    logger.warn('chatPubSub', 'Redis pub/sub unavailable: ' + String(e));
  }
}

export async function publishConvEvent(convId: string, event: ChatWsEvent): Promise<void> {
  try {
    await getRedis().publish(`chat:conv:${convId}`, JSON.stringify(event));
  } catch { /* best effort */ }
}

export async function publishUserInbox(userId: string, convId: string): Promise<void> {
  const event: ChatWsEvent = { type: 'inbox.update', conv_id: convId };
  try {
    await getRedis().publish(`chat:user:${userId}`, JSON.stringify(event));
  } catch { /* best effort */ }
}

export async function notifyConversationMembers(
  convId: string,
  memberIds: string[],
  event: ChatWsEvent,
): Promise<void> {
  await publishConvEvent(convId, event);
  await Promise.all(memberIds.map((uid) => publishUserInbox(uid, convId)));
}
