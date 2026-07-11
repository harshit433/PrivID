import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AccessToken } from 'livekit-server-sdk';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { query, queryOne } from '@trustroute/shared';
import {
  listConversations,
  listMessages,
  sendMessage,
  getOrCreateDmConversation,
  markRead,
  setMuted,
  setPinned,
  assertMember,
  getConversationContext,
  addReaction,
  removeReaction,
  softDeleteMessage,
  clearConversationForUser,
  listConversationMedia,
} from '../services/nativeChat';
import { notifyConversationMembers } from '../services/chatPubSub';
import { chatSendLimiter } from '../middleware/rateLimit';

export const chatsRouter = Router();
chatsRouter.use(requireAuth);

chatsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await listConversations(req.user!.sub);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

const openDmSchema = z.object({
  other_user_id: z.string().uuid().optional(),
  handle: z.string().optional(),
}).refine((d) => d.other_user_id || d.handle, { message: 'other_user_id or handle required' });

chatsRouter.post('/open', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = openDmSchema.parse(req.body);
    let otherId = body.other_user_id;
    if (!otherId && body.handle) {
      const u = await queryOne<{ user_id: string }>(
        `SELECT user_id FROM users WHERE lower(handle) = lower($1)`,
        [body.handle.replace(/^@/, '')],
      );
      if (!u) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
      otherId = u.user_id;
    }
    const convId = await getOrCreateDmConversation(req.user!.sub, otherId!);
    res.json({ ok: true, data: { conv_id: convId } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0]!.message));
    }
    next(err);
  }
});

chatsRouter.get('/:id/messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const beforeSeq = req.query.before_seq ? parseInt(String(req.query.before_seq), 10) : undefined;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
    const data = await listMessages(req.params.id!, req.user!.sub, { beforeSeq, limit });
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

const sendSchema = z.object({
  type: z.enum(['text', 'image', 'video', 'audio', 'doc', 'contact', 'location', 'system']).default('text'),
  body: z.string().max(8000).optional(),
  media_ref: z.string().optional(),
  reply_to: z.string().uuid().optional(),
  client_msg_id: z.string().optional(),
});

chatsRouter.post('/:id/messages', chatSendLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = sendSchema.parse(req.body);
    const message = await sendMessage({
      convId: req.params.id!,
      senderId: req.user!.sub,
      type: body.type,
      body: body.body,
      mediaRef: body.media_ref,
      replyTo: body.reply_to,
      clientMsgId: body.client_msg_id,
    });
    const members = await query<{ user_id: string }>(
      `SELECT user_id FROM conversation_members WHERE conv_id = $1`,
      [req.params.id],
    );
    await notifyConversationMembers(req.params.id!, members.map((m) => m.user_id), {
      type: 'message.new',
      conv_id: req.params.id!,
      message,
    });
    const { sendChatMessagePush } = await import('../services/fcm');
    for (const m of members) {
      if (m.user_id !== req.user!.sub) {
        void sendChatMessagePush(m.user_id, req.params.id!, req.user!.sub, body.body ?? '[attachment]');
      }
    }
    res.json({ ok: true, data: message });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0]!.message));
    }
    next(err);
  }
});

chatsRouter.post('/:id/read', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { up_to_seq } = z.object({ up_to_seq: z.number().int().positive() }).parse(req.body);
    await markRead(req.params.id!, req.user!.sub, up_to_seq);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0]!.message));
    }
    next(err);
  }
});

chatsRouter.patch('/:id/mute', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { hours } = z.object({ hours: z.number().int().min(0).max(8760).nullable() }).parse(req.body);
    const until = hours && hours > 0 ? new Date(Date.now() + hours * 3600_000) : null;
    await setMuted(req.params.id!, req.user!.sub, until);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0]!.message));
    }
    next(err);
  }
});

chatsRouter.patch('/:id/pin', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { pinned } = z.object({ pinned: z.boolean() }).parse(req.body);
    await setPinned(req.params.id!, req.user!.sub, pinned);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0]!.message));
    }
    next(err);
  }
});

chatsRouter.get('/:id/context', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await getConversationContext(req.params.id!, req.user!.sub);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

chatsRouter.post('/:id/messages/:msgId/reactions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { emoji } = z.object({ emoji: z.string().min(1).max(16) }).parse(req.body);
    await addReaction(req.params.msgId!, req.user!.sub, emoji);
    const members = await query<{ user_id: string }>(
      `SELECT user_id FROM conversation_members WHERE conv_id = $1`,
      [req.params.id],
    );
    await notifyConversationMembers(req.params.id!, members.map((m) => m.user_id), {
      type: 'reaction',
      conv_id: req.params.id!,
      msg_id: req.params.msgId!,
      user_id: req.user!.sub,
      emoji,
      action: 'add',
    });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0]!.message));
    }
    next(err);
  }
});

chatsRouter.delete('/:id/messages/:msgId/reactions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await removeReaction(req.params.msgId!, req.user!.sub);
    const members = await query<{ user_id: string }>(
      `SELECT user_id FROM conversation_members WHERE conv_id = $1`,
      [req.params.id],
    );
    await notifyConversationMembers(req.params.id!, members.map((m) => m.user_id), {
      type: 'reaction',
      conv_id: req.params.id!,
      msg_id: req.params.msgId!,
      user_id: req.user!.sub,
      action: 'remove',
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

chatsRouter.delete('/:id/messages/:msgId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { for_everyone } = z.object({ for_everyone: z.boolean().default(false) }).parse(req.body ?? {});
    await softDeleteMessage(req.params.msgId!, req.user!.sub, for_everyone);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0]!.message));
    }
    next(err);
  }
});

chatsRouter.post('/:id/clear', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const count = await clearConversationForUser(req.params.id!, req.user!.sub);
    res.json({ ok: true, data: { cleared: count } });
  } catch (err) {
    next(err);
  }
});

chatsRouter.get('/:id/media', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const kind = req.query.kind as 'image' | 'video' | 'doc' | undefined;
    const data = await listConversationMedia(req.params.id!, req.user!.sub, kind);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

// Group A/V call — LiveKit room per conversation
chatsRouter.post('/:id/call', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { mode } = z.object({ mode: z.enum(['voice', 'video']).default('voice') }).parse(req.body ?? {});
    const convId = req.params.id!;
    await assertMember(convId, req.user!.sub);

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const livekitUrl = process.env.LIVEKIT_URL ?? 'ws://localhost:7880';
    if (!apiKey || !apiSecret) {
      throw new AppError(503, 'LIVEKIT_NOT_CONFIGURED', 'Group calls are not available.');
    }

    const roomName = `groupchat-${convId}`;
    const at = new AccessToken(apiKey, apiSecret, {
      identity: req.user!.sub,
      ttl: '2h',
    });
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    });

    const members = await query<{ user_id: string }>(
      `SELECT user_id FROM conversation_members WHERE conv_id = $1 AND user_id <> $2`,
      [convId, req.user!.sub],
    );
    const { sendGroupCallPush } = await import('../services/fcm');
    for (const m of members) {
      void sendGroupCallPush(m.user_id, convId, req.user!.sub, mode);
    }

    res.json({
      ok: true,
      data: {
        room_id: roomName,
        token: await at.toJwt(),
        url: livekitUrl,
        mode,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0]!.message));
    }
    next(err);
  }
});
