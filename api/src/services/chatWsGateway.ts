import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import type { AccessTokenPayload } from '@trustroute/shared';
import { query } from '@trustroute/shared';
import { initChatPubSub, type ChatWsEvent } from './chatPubSub';
import { sendMessage, markRead, assertMember, addReaction, removeReaction } from './nativeChat';
import { checkChatSendRate } from '../middleware/rateLimit';
import { logger } from '../utils/logger';
import { isMatrixConfigured } from './matrix';

type Client = {
  ws: WebSocket;
  userId: string;
  convIds: Set<string>;
};

const clients = new Map<string, Set<Client>>();

let publicKey: string | null = null;
function getPublicKey(): string {
  if (!publicKey) {
    if (process.env.JWT_PUBLIC_KEY_B64) {
      publicKey = Buffer.from(process.env.JWT_PUBLIC_KEY_B64, 'base64').toString('utf8');
    } else {
      publicKey = fs.readFileSync(path.resolve(process.env.JWT_PUBLIC_KEY_PATH ?? './keys/public.pem'), 'utf8');
    }
  }
  return publicKey;
}

function verifyToken(token: string): AccessTokenPayload | null {
  try {
    return jwt.verify(token, getPublicKey()) as AccessTokenPayload;
  } catch {
    return null;
  }
}

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastToUser(userId: string, payload: unknown): void {
  const set = clients.get(userId);
  if (!set) return;
  for (const c of set) send(c.ws, payload);
}

function broadcastToConv(convId: string, payload: unknown, exceptUserId?: string): void {
  for (const [, set] of clients) {
    for (const c of set) {
      if (c.convIds.has(convId) && c.userId !== exceptUserId) {
        send(c.ws, payload);
      }
    }
  }
}

export function attachChatWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/ws/chat' });

  void initChatPubSub((event: ChatWsEvent) => {
    if (event.type === 'message.new') {
      broadcastToConv(event.conv_id, event);
    } else if (event.type === 'inbox.update') {
      // fan-out handled per-user via user channel subscriptions in clients
    } else {
      broadcastToConv(event.conv_id, event);
    }
  });

  wss.on('connection', async (ws, req) => {
    if (isMatrixConfigured()) {
      ws.close(1000, 'native_chat_retired');
      return;
    }
    const url = new URL(req.url ?? '', 'http://localhost');
    const token = url.searchParams.get('token');
    if (!token) {
      ws.close(4001, 'Unauthorized');
      return;
    }
    const payload = verifyToken(token);
    if (!payload?.sub) {
      ws.close(4001, 'Unauthorized');
      return;
    }
    const userId = payload.sub;

    const memberRows = await query<{ conv_id: string }>(
      `SELECT conv_id FROM conversation_members WHERE user_id = $1`,
      [userId],
    );
    const convIds = new Set(memberRows.map((r) => r.conv_id));

    const client: Client = { ws, userId, convIds };
    if (!clients.has(userId)) clients.set(userId, new Set());
    clients.get(userId)!.add(client);

    send(ws, { type: 'connected', user_id: userId });

    const heartbeat = setInterval(() => send(ws, { type: 'ping' }), 25_000);

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          type: string;
          conv_id?: string;
          body?: string;
          msg_type?: string;
          media_ref?: string;
          reply_to?: string;
          up_to_seq?: number;
          is_typing?: boolean;
          msg_id?: string;
          emoji?: string;
        };

        switch (msg.type) {
          case 'pong':
            break;
          case 'message.send': {
            if (!msg.conv_id) return;
            await checkChatSendRate(userId);
            const message = await sendMessage({
              convId: msg.conv_id,
              senderId: userId,
              type: (msg.msg_type as any) ?? 'text',
              body: msg.body,
              mediaRef: msg.media_ref,
              replyTo: msg.reply_to,
              clientMsgId: (msg as { client_msg_id?: string }).client_msg_id,
            });
            const members = await query<{ user_id: string }>(
              `SELECT user_id FROM conversation_members WHERE conv_id = $1`,
              [msg.conv_id],
            );
            const { notifyConversationMembers } = await import('./chatPubSub');
            await notifyConversationMembers(msg.conv_id, members.map((m) => m.user_id), {
              type: 'message.new',
              conv_id: msg.conv_id,
              message,
            });
            const { sendChatMessagePush } = await import('./fcm');
            for (const m of members) {
              if (m.user_id !== userId) {
                void sendChatMessagePush(m.user_id, msg.conv_id, userId, msg.body ?? '[attachment]');
              }
            }
            send(ws, { type: 'message.ack', message });
            break;
          }
          case 'receipt.read': {
            if (!msg.conv_id || !msg.up_to_seq) return;
            await markRead(msg.conv_id, userId, msg.up_to_seq);
            broadcastToConv(msg.conv_id, {
              type: 'message.status',
              conv_id: msg.conv_id,
              user_id: userId,
              state: 'read',
              up_to_seq: msg.up_to_seq,
            }, userId);
            break;
          }
          case 'typing': {
            if (!msg.conv_id) return;
            broadcastToConv(msg.conv_id, {
              type: 'typing',
              conv_id: msg.conv_id,
              user_id: userId,
              is_typing: !!msg.is_typing,
            }, userId);
            break;
          }
          case 'reaction.add': {
            if (!msg.conv_id || !msg.msg_id || !msg.emoji) return;
            await addReaction(msg.msg_id, userId, msg.emoji);
            const { notifyConversationMembers } = await import('./chatPubSub');
            const members = await query<{ user_id: string }>(
              `SELECT user_id FROM conversation_members WHERE conv_id = $1`,
              [msg.conv_id],
            );
            await notifyConversationMembers(msg.conv_id, members.map((m) => m.user_id), {
              type: 'reaction',
              conv_id: msg.conv_id,
              msg_id: msg.msg_id,
              user_id: userId,
              emoji: msg.emoji,
              action: 'add',
            });
            break;
          }
          case 'reaction.remove': {
            if (!msg.conv_id || !msg.msg_id) return;
            await removeReaction(msg.msg_id, userId);
            const { notifyConversationMembers: notifyRm } = await import('./chatPubSub');
            const rmMembers = await query<{ user_id: string }>(
              `SELECT user_id FROM conversation_members WHERE conv_id = $1`,
              [msg.conv_id],
            );
            await notifyRm(msg.conv_id, rmMembers.map((m) => m.user_id), {
              type: 'reaction',
              conv_id: msg.conv_id,
              msg_id: msg.msg_id,
              user_id: userId,
              action: 'remove',
            });
            break;
          }
          default:
            break;
        }
      } catch (e) {
        send(ws, { type: 'error', message: 'Could not process message.' });
        logger.warn('chatWs', 'WS handler error: ' + String(e));
      }
    });

    ws.on('close', () => {
      clearInterval(heartbeat);
      clients.get(userId)?.delete(client);
      if (clients.get(userId)?.size === 0) clients.delete(userId);
    });
  });

  logger.debug('chatWs', 'WebSocket gateway attached at /ws/chat');
}
