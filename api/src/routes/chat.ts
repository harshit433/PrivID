import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '@trustroute/shared';
import type { ConnectionType } from '@trustroute/shared';
import { logger } from '../utils/logger';
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
  createGroupChannel,
  addGroupMember,
  setGroupMemberRole,
  removeGroupMember,
  updateGroupChannel,
  deleteGroupChannel,
  deleteMessageAsAdmin,
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
    const requireSignature = process.env.NODE_ENV === 'production';
    if (requireSignature && (!signature || !rawBody)) {
      return res.status(401).json({ error: 'missing signature' });
    }
    if (signature && rawBody && !sc.verifyWebhook(rawBody.toString(), signature)) {
      return res.status(401).json({ error: 'invalid signature' });
    }

    const body = req.body ?? {};
    const message = body.message;
    const channelType = body.channel_type ?? (body.cid ? String(body.cid).split(':')[0] : undefined);

    // Only enforce on messaging channels with a real message.
    if (!message || !message.id || channelType !== 'messaging') {
      return res.status(200).json({});
    }

    const senderId: string | undefined = message.user?.id ?? body.user?.id;
    if (!senderId) return res.status(200).json({});

    // Group channels skip 1:1 permission gating — membership IS the permission.
    // Stream natively prevents non-members from sending to group channels.
    const channelData = body.channel ?? {};
    if (channelData.is_group === true || channelData.custom?.is_group === true) {
      return res.status(200).json({});
    }

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

    // Cannot resolve a 1:1 recipient — allow (e.g. unrecognised channel type).
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

    // Accepted — record counters asynchronously (webhook must respond quickly).
    if (cid) {
      void logMessage(message.id, cid, senderId, recipientId).catch(() => {});
    }

    return res.status(200).json({});
  } catch (err: any) {
    const failClosed = process.env.NODE_ENV === 'production';
    logger.warn('chat/webhook', failClosed ? 'Internal error — failing closed' : 'Internal error — failing open', {
      error: err?.message,
    });

    if (!failClosed) return res.status(200).json({});

    // Fail closed in production — never allow delivery when the gate is uncertain.
    // If we have a message payload, echo it back with type "error" so Stream rejects it.
    const body = (req as any).body ?? {};
    const message = body.message;
    if (message && message.id) {
      return res.status(200).json({
        message: {
          ...message,
          type: 'error',
          text: 'Message could not be verified right now. Please try again.',
        },
      });
    }
    return res.status(401).json({ error: 'verification failed' });
  }
});

// ─── Group channel routes ──────────────────────────────────────────────────────
//
// Groups are Stream messaging channels with is_group=true and an explicit ID.
// Membership and role are mirrored to group_members for fast server-side checks.

const createGroupSchema = z.object({
  name:       z.string().min(1).max(100).transform((s) => s.trim()),
  member_ids: z.array(z.string().uuid()).min(1).max(49),
  avatar_url: z.string().url().optional().nullable(),
});

// ─── POST /chat/groups ────────────────────────────────────────────────────────
chatRouter.post('/groups', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isStreamConfigured()) throw new AppError(503, 'STREAM_NOT_CONFIGURED', 'Chat is not configured.');
    const { name, member_ids, avatar_url } = createGroupSchema.parse(req.body);
    const creatorId = req.user!.sub;

    const groupId = crypto.randomUUID();
    const channelId = `group-${groupId}`;
    const channelCid = `messaging:${channelId}`;
    const allMemberIds = [...new Set([creatorId, ...member_ids])];

    // Verify all members exist and are active (single batch query — no N+1)
    const foundMembers = await query<{ user_id: string }>(
      `SELECT user_id FROM users WHERE user_id = ANY($1::uuid[]) AND is_active = TRUE`,
      [member_ids],
    );
    if (foundMembers.length !== member_ids.length) {
      const foundIds = new Set(foundMembers.map((r) => r.user_id));
      const missing = member_ids.find((uid) => !foundIds.has(uid));
      throw new AppError(400, 'MEMBER_NOT_FOUND', `User ${missing} not found or inactive.`);
    }

    // Upsert all members into Stream so they can receive messages (before DB/Stream channel writes)
    const memberRows = await query<{ user_id: string; handle: string; display_name: string | null; avatar_url: string | null }>(
      `SELECT user_id, handle, display_name, avatar_url FROM users WHERE user_id = ANY($1)`,
      [allMemberIds],
    );
    await Promise.all(memberRows.map((u) => upsertStreamUser(u)));

    // 1. Persist to DB first (can be compensated on Stream failure)
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO group_channels (group_id, channel_cid, name, description, avatar_url, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [groupId, channelCid, name, null, avatar_url ?? null, creatorId],
      );
      await client.query(
        `INSERT INTO group_members (group_id, user_id, role)
         SELECT $1, unnest($2::uuid[]), 'member'
         ON CONFLICT DO NOTHING`,
        [groupId, allMemberIds],
      );
      // Set creator as admin
      await client.query(
        `UPDATE group_members SET role = 'admin' WHERE group_id = $1 AND user_id = $2`,
        [groupId, creatorId],
      );
    });

    // 2. Create Stream channel after DB committed (Stream is not transactional)
    try {
      await createGroupChannel(channelId, name, creatorId, member_ids, avatar_url);
    } catch (streamErr) {
      logger.error('stream', 'Group channel creation failed', {
        err: streamErr instanceof Error ? streamErr.message : String(streamErr),
        groupId,
        channelId,
      });
      // Compensate: remove the DB rows since Stream channel doesn't exist
      await query(`DELETE FROM group_channels WHERE group_id = $1`, [groupId]).catch(() => {});
      throw new AppError(503, 'STREAM_ERROR', 'Failed to create group chat. Please try again.');
    }

    res.status(201).json({
      ok: true,
      data: { group_id: groupId, channel_cid: channelCid, channel_id: channelId, name, avatar_url: avatar_url ?? null },
    });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── GET /chat/groups/with/:userId ───────────────────────────────────────────
// Returns groups where BOTH the requester AND the specified user are members.
// Used by ContactDetailScreen to show mutual groups.
chatRouter.get('/groups/with/:otherUserId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const myId = req.user!.sub;
    const { otherUserId } = req.params;
    if (myId === otherUserId) return res.json({ ok: true, data: [] });

    const groups = await query<{
      group_id: string; channel_cid: string; name: string; avatar_url: string | null; created_by: string; role: string; member_count: number;
    }>(
      `SELECT g.group_id, g.channel_cid, g.name, g.avatar_url, g.created_by,
              gm.role,
              (SELECT count(*) FROM group_members gm2 WHERE gm2.group_id = g.group_id)::int AS member_count
         FROM group_channels g
         JOIN group_members gm  ON gm.group_id  = g.group_id AND gm.user_id  = $1
         JOIN group_members gm3 ON gm3.group_id = g.group_id AND gm3.user_id = $2
        ORDER BY g.created_at DESC`,
      [myId, otherUserId],
    );
    res.json({ ok: true, data: groups });
  } catch (err) { next(err); }
});

// ─── GET /chat/groups ─────────────────────────────────────────────────────────
chatRouter.get('/groups', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const groups = await query<{
      group_id: string; channel_cid: string; name: string; avatar_url: string | null; created_by: string; role: string; member_count: number;
    }>(
      `SELECT g.group_id, g.channel_cid, g.name, g.avatar_url, g.created_by,
              gm.role,
              (SELECT count(*) FROM group_members gm2 WHERE gm2.group_id = g.group_id)::int AS member_count
         FROM group_channels g
         JOIN group_members gm ON gm.group_id = g.group_id AND gm.user_id = $1
        ORDER BY g.created_at DESC`,
      [userId],
    );
    res.json({ ok: true, data: groups });
  } catch (err) { next(err); }
});

// ─── GET /chat/groups/:groupId ────────────────────────────────────────────────
chatRouter.get('/groups/:groupId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const { groupId } = req.params;

    const group = await queryOne<{ group_id: string; channel_cid: string; name: string; avatar_url: string | null; created_by: string }>(
      `SELECT group_id, channel_cid, name, avatar_url, created_by FROM group_channels WHERE group_id = $1`, [groupId],
    );
    if (!group) throw new AppError(404, 'GROUP_NOT_FOUND', 'Group not found.');

    const membership = await queryOne<{ role: string }>(
      `SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2`, [groupId, userId],
    );
    if (!membership) throw new AppError(403, 'NOT_A_MEMBER', 'You are not a member of this group.');

    const members = await query<{
      user_id: string; handle: string; display_name: string; avatar_url: string | null; role: string;
    }>(
      `SELECT u.user_id, u.handle, u.display_name, u.avatar_url, gm.role
         FROM group_members gm
         JOIN users u ON u.user_id = gm.user_id
        WHERE gm.group_id = $1
        ORDER BY gm.role DESC, u.display_name`,
      [groupId],
    );

    res.json({
      ok: true,
      data: { ...group, my_role: membership.role, members },
    });
  } catch (err) { next(err); }
});

// ─── PATCH /chat/groups/:groupId ─────────────────────────────────────────────
const updateGroupSchema = z.object({
  name:       z.string().min(1).max(100).transform((s) => s.trim()).optional(),
  avatar_url: z.string().url().nullable().optional(),
});

chatRouter.patch('/groups/:groupId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const { groupId } = req.params;
    const updates = updateGroupSchema.parse(req.body);

    const membership = await queryOne<{ role: string }>(
      `SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2`, [groupId, userId],
    );
    if (!membership) throw new AppError(403, 'NOT_A_MEMBER', 'You are not a member of this group.');
    if (membership.role !== 'admin') throw new AppError(403, 'NOT_ADMIN', 'Only admins can update group settings.');

    const group = await queryOne<{ channel_cid: string; name: string; avatar_url: string | null }>(
      `SELECT channel_cid, name, avatar_url FROM group_channels WHERE group_id = $1`, [groupId],
    );
    if (!group) throw new AppError(404, 'GROUP_NOT_FOUND', 'Group not found.');

    const newName = updates.name ?? group.name;
    const newAvatar = updates.avatar_url !== undefined ? updates.avatar_url : group.avatar_url;
    const channelId = group.channel_cid.replace('messaging:', '');

    await Promise.all([
      query(
        `UPDATE group_channels SET name = $1, avatar_url = $2, updated_at = NOW() WHERE group_id = $3`,
        [newName, newAvatar, groupId],
      ),
      updateGroupChannel(channelId, { name: newName, image: newAvatar }),
    ]);

    res.json({ ok: true, data: { group_id: groupId, name: newName, avatar_url: newAvatar } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── DELETE /chat/groups/:groupId ────────────────────────────────────────────
chatRouter.delete('/groups/:groupId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const { groupId } = req.params;

    const membership = await queryOne<{ role: string }>(
      `SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2`, [groupId, userId],
    );
    if (!membership) throw new AppError(403, 'NOT_A_MEMBER', 'You are not a member of this group.');
    if (membership.role !== 'admin') throw new AppError(403, 'NOT_ADMIN', 'Only admins can delete the group.');

    const group = await queryOne<{ channel_cid: string }>(
      `SELECT channel_cid FROM group_channels WHERE group_id = $1`, [groupId],
    );
    if (!group) throw new AppError(404, 'GROUP_NOT_FOUND', 'Group not found.');

    const channelId = group.channel_cid.replace('messaging:', '');
    await Promise.all([
      query(`DELETE FROM group_channels WHERE group_id = $1`, [groupId]),
      deleteGroupChannel(channelId).catch(() => {}),
    ]);

    res.json({ ok: true, data: null });
  } catch (err) { next(err); }
});

// ─── POST /chat/groups/:groupId/members ──────────────────────────────────────
chatRouter.post('/groups/:groupId/members', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const { groupId } = req.params;
    const { user_id: targetId } = z.object({ user_id: z.string().uuid() }).parse(req.body);

    const membership = await queryOne<{ role: string }>(
      `SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2`, [groupId, userId],
    );
    if (!membership) throw new AppError(403, 'NOT_A_MEMBER', 'You are not a member of this group.');
    if (membership.role !== 'admin') throw new AppError(403, 'NOT_ADMIN', 'Only admins can add members.');

    const alreadyIn = await queryOne(
      `SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2`, [groupId, targetId],
    );
    if (alreadyIn) throw new AppError(409, 'ALREADY_MEMBER', 'This person is already in the group.');

    const target = await queryOne<{ user_id: string; handle: string; display_name: string | null; avatar_url: string | null }>(
      `SELECT user_id, handle, display_name, avatar_url FROM users WHERE user_id = $1 AND is_active = TRUE`, [targetId],
    );
    if (!target) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');

    const group = await queryOne<{ channel_cid: string }>(
      `SELECT channel_cid FROM group_channels WHERE group_id = $1`, [groupId],
    );
    if (!group) throw new AppError(404, 'GROUP_NOT_FOUND', 'Group not found.');

    const channelId = group.channel_cid.replace('messaging:', '');
    await upsertStreamUser(target);
    await Promise.all([
      addGroupMember(channelId, targetId),
      query(`INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'member')`, [groupId, targetId]),
    ]);

    res.status(201).json({ ok: true, data: { user_id: targetId, role: 'member' } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── DELETE /chat/groups/:groupId/members/:userId ────────────────────────────
// Used for: leaving a group (userId === self) or removing a member (admin only).
chatRouter.delete('/groups/:groupId/members/:targetUserId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const myId = req.user!.sub;
    const { groupId, targetUserId } = req.params;

    const myMembership = await queryOne<{ role: string }>(
      `SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2`, [groupId, myId],
    );
    if (!myMembership) throw new AppError(403, 'NOT_A_MEMBER', 'You are not a member of this group.');

    const isSelf = myId === targetUserId;
    if (!isSelf && myMembership.role !== 'admin') {
      throw new AppError(403, 'NOT_ADMIN', 'Only admins can remove members.');
    }

    const targetMembership = await queryOne<{ role: string }>(
      `SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2`, [groupId, targetUserId],
    );
    if (!targetMembership) throw new AppError(404, 'NOT_A_MEMBER', 'This person is not in the group.');

    const group = await queryOne<{ channel_cid: string }>(
      `SELECT channel_cid FROM group_channels WHERE group_id = $1`, [groupId],
    );
    if (!group) throw new AppError(404, 'GROUP_NOT_FOUND', 'Group not found.');

    const channelId = group.channel_cid.replace('messaging:', '');
    await Promise.all([
      removeGroupMember(channelId, targetUserId),
      query(`DELETE FROM group_members WHERE group_id = $1 AND user_id = $2`, [groupId, targetUserId]),
    ]);

    res.json({ ok: true, data: null });
  } catch (err) { next(err); }
});

// ─── PATCH /chat/groups/:groupId/members/:userId/role ────────────────────────
chatRouter.patch('/groups/:groupId/members/:targetUserId/role', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const myId = req.user!.sub;
    const { groupId, targetUserId } = req.params;
    const { role } = z.object({ role: z.enum(['admin', 'member']) }).parse(req.body);

    const myMembership = await queryOne<{ role: string }>(
      `SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2`, [groupId, myId],
    );
    if (!myMembership || myMembership.role !== 'admin') {
      throw new AppError(403, 'NOT_ADMIN', 'Only admins can change member roles.');
    }
    if (myId === targetUserId) throw new AppError(400, 'SELF_ROLE', 'You cannot change your own admin role.');

    const group = await queryOne<{ channel_cid: string }>(
      `SELECT channel_cid FROM group_channels WHERE group_id = $1`, [groupId],
    );
    if (!group) throw new AppError(404, 'GROUP_NOT_FOUND', 'Group not found.');

    const channelId = group.channel_cid.replace('messaging:', '');
    await Promise.all([
      setGroupMemberRole(channelId, targetUserId, role === 'admin'),
      query(
        `UPDATE group_members SET role = $1 WHERE group_id = $2 AND user_id = $3`,
        [role, groupId, targetUserId],
      ),
    ]);

    res.json({ ok: true, data: { user_id: targetUserId, role } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── DELETE /chat/messages/:messageId ────────────────────────────────────────
// Admin-side delete for any message (group or 1:1). Regular users use Stream's
// client SDK directly (they can only delete their own messages).
chatRouter.delete('/messages/:messageId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const { messageId } = req.params;

    // Verify the requester is a group admin for the channel that contains this message.
    // We look up by message ID via Stream's API, then check our DB.
    const sc = getStreamClient();
    const { message } = await sc.getMessage(messageId);
    if (!message) throw new AppError(404, 'MESSAGE_NOT_FOUND', 'Message not found.');

    const cid: string = (message as any).cid ?? '';
    const isGroupAdmin = await queryOne(
      `SELECT 1 FROM group_channels gc
       JOIN group_members gm ON gm.group_id = gc.group_id AND gm.user_id = $1 AND gm.role = 'admin'
       WHERE gc.channel_cid = $2`,
      [userId, cid],
    );
    if (!isGroupAdmin) throw new AppError(403, 'NOT_ADMIN', 'Only group admins can delete others\' messages.');

    await deleteMessageAsAdmin(messageId);
    res.json({ ok: true, data: null });
  } catch (err) { next(err); }
});

