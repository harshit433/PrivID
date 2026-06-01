import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { queryOne } from '@trustroute/shared';
import type { ConnectionType } from '@trustroute/shared';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import {
  isStreamConfigured,
  getStreamClient,
  getStreamApiKey,
  upsertStreamUser,
  createUserToken,
  getOrCreateDirectChannel,
  getConnectionTypeFor,
  gateForSender,
  countMessagesSent,
  logMessage,
  CHAT_UNKNOWN_TOTAL_LIMIT,
} from '../services/stream';

export const chatRouter = Router();

interface UserLite {
  user_id: string;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
  trust_tier: string;
  trust_score: number;
}

// ─── GET /chat/token ──────────────────────────────────────────────────────────
// Issued on every app launch. Upserts the user into Stream and returns a token.

chatRouter.get('/token', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isStreamConfigured()) {
      throw new AppError(503, 'STREAM_NOT_CONFIGURED', 'Chat is not configured on the server.');
    }
    const me = await queryOne<UserLite>(
      `SELECT user_id, handle, display_name, avatar_url, trust_tier, trust_score
       FROM users WHERE user_id = $1`,
      [req.user!.sub],
    );
    if (!me) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');

    await upsertStreamUser(me);
    const token = createUserToken(me.user_id);

    res.json({
      ok: true,
      data: {
        api_key: getStreamApiKey(),
        token,
        user: {
          id: me.user_id,
          name: me.display_name ?? me.handle,
          image: me.avatar_url ?? undefined,
          handle: me.handle,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Context builder (shared by channel create + refresh) ─────────────────────

async function buildContext(myId: string, other: UserLite) {
  const otherId = other.user_id;
  const [mine, outgoing, theirMessagesToMe] = await Promise.all([
    getConnectionTypeFor(myId, otherId),          // me → them
    gateForSender(myId, otherId),                 // my ability to send (their view of me)
    countMessagesSent(otherId, myId),             // how many they've sent me
  ]);

  const theirIntroRemaining = Math.max(0, CHAT_UNKNOWN_TOTAL_LIMIT - theirMessagesToMe);

  return {
    other_user: {
      user_id: other.user_id,
      handle: other.handle,
      display_name: other.display_name ?? other.handle,
      avatar_url: other.avatar_url,
      trust_tier: other.trust_tier,
      trust_score: other.trust_score,
    },
    my_connection_type: mine.connection_type as ConnectionType,
    their_connection_type: outgoing.connection_type,
    outgoing,
    incoming: {
      is_unknown: mine.connection_type === 'unknown',
      their_messages_used: theirMessagesToMe,
      their_intro_remaining: theirIntroRemaining,
    },
  };
}

// ─── POST /chat/channels ──────────────────────────────────────────────────────
// Get-or-create a 1:1 channel with another user and return the full permission
// context (both directions of the shared connection + send allowance).

const channelSchema = z.object({
  other_user_id: z.string().uuid().optional(),
  handle: z.string().optional(),
}).refine((d) => d.other_user_id || d.handle, {
  message: 'Either other_user_id or handle is required.',
});

chatRouter.post('/channels', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isStreamConfigured()) {
      throw new AppError(503, 'STREAM_NOT_CONFIGURED', 'Chat is not configured on the server.');
    }
    const body = channelSchema.parse(req.body);
    const myId = req.user!.sub;

    const other = await queryOne<UserLite>(
      body.other_user_id
        ? `SELECT user_id, handle, display_name, avatar_url, trust_tier, trust_score FROM users WHERE user_id = $1 AND is_active = TRUE`
        : `SELECT user_id, handle, display_name, avatar_url, trust_tier, trust_score FROM users WHERE handle = $1 AND is_active = TRUE`,
      [body.other_user_id ?? body.handle],
    );
    if (!other) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
    if (other.user_id === myId) throw new AppError(400, 'SELF_CHAT', 'Cannot message yourself.');

    // Ensure both users exist in Stream before creating the channel.
    await upsertStreamUser(other);

    const channel = await getOrCreateDirectChannel(myId, other.user_id);
    const context = await buildContext(myId, other);

    res.status(201).json({ ok: true, data: { channel, ...context } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── GET /chat/channels/:otherUserId/context ──────────────────────────────────
// Refresh the permission context for an existing conversation (no channel
// creation). Used by the chat screen to re-evaluate the banner after actions.

chatRouter.get('/channels/:otherUserId/context', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const myId = req.user!.sub;
    const other = await queryOne<UserLite>(
      `SELECT user_id, handle, display_name, avatar_url, trust_tier, trust_score
       FROM users WHERE user_id = $1 AND is_active = TRUE`,
      [req.params.otherUserId],
    );
    if (!other) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');

    const context = await buildContext(myId, other);
    res.json({ ok: true, data: context });
  } catch (err) {
    next(err);
  }
});

// ─── POST /chat/webhook ───────────────────────────────────────────────────────
// Stream "Before Message Send" hook. Enforces the shared connection rules
// server-side and logs accepted messages for the intro/daily counters.
//
// Configure in the Stream dashboard:
//   Chat → Overview → Webhooks → "Before Message Send" URL = <API_URL>/chat/webhook
//
// Stream signs the raw body with the app secret (header `x-signature`). To
// reject a message we echo it back with type "error" — Stream then surfaces an
// error to the sender and does NOT persist the message.

chatRouter.post('/webhook', async (req: Request, res: Response) => {
  try {
    if (!isStreamConfigured()) {
      return res.status(200).json({}); // nothing to enforce
    }

    // Verify signature against the raw body captured in server.ts
    const signature = req.headers['x-signature'] as string | undefined;
    const rawBody = (req as any).rawBody as Buffer | undefined;
    const sc = getStreamClient();
    if (signature && rawBody && !sc.verifyWebhook(rawBody.toString(), signature)) {
      return res.status(401).json({ error: 'invalid signature' });
    }

    const body = req.body ?? {};
    const message = body.message;
    const channelType = body.channel_type ?? (body.cid ? String(body.cid).split(':')[0] : undefined);

    // Only enforce on 1:1 messaging channels with a real text message.
    if (!message || !message.id || channelType !== 'messaging') {
      return res.status(200).json({});
    }

    const senderId: string | undefined = message.user?.id ?? body.user?.id;
    if (!senderId) return res.status(200).json({});

    // Resolve the recipient: the other member of the 1:1 channel.
    const cid: string | undefined = body.cid;
    let recipientId: string | undefined;
    const members: any[] = body.members ?? body.channel?.members ?? [];
    for (const m of members) {
      const mid = m.user_id ?? m.user?.id;
      if (mid && mid !== senderId) { recipientId = mid; break; }
    }
    if (!recipientId && cid) {
      const mapping = await queryOne<{ member_low: string; member_high: string }>(
        `SELECT member_low, member_high FROM chat_channels WHERE channel_cid = $1`,
        [cid],
      );
      if (mapping) {
        recipientId = mapping.member_low === senderId ? mapping.member_high : mapping.member_low;
      }
    }

    // Cannot resolve a 1:1 recipient — allow (e.g. group channel).
    if (!recipientId) return res.status(200).json({});

    const gate = await gateForSender(senderId, recipientId);

    if (!gate.can_send) {
      // Reject: echo message back as an error type so Stream does not store it.
      return res.status(200).json({
        message: {
          ...message,
          type: 'error',
          text: gate.reason ?? 'Message not allowed.',
        },
      });
    }

    // Accepted — record it for the counters.
    if (cid) {
      await logMessage(message.id, cid, senderId, recipientId).catch(() => {});
    }

    return res.status(200).json({});
  } catch (err: any) {
    console.warn('[chat] webhook error:', err?.message);
    // Fail open — never block delivery on an internal error.
    return res.status(200).json({});
  }
});
