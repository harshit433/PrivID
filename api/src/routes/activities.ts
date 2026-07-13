import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { query, queryOne, withTransaction } from '@trustroute/shared';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { upsertStreamUser, isStreamConfigured } from '../services/stream';
import {
  rtdbAppendActivityMessage,
  rtdbCreateActivitySession,
  rtdbEndActivitySession,
  rtdbUpdateActivityControl,
  rtdbUpdateActivityParticipant,
  rtdbUpdateActivityState,
  sendActivityPartyPush,
  type ActivityAdapter,
} from '../services/fcm';

export const activitiesRouter = Router();

type ScopeType = 'direct' | 'group';
type ActivityStatus = 'active' | 'ended';

interface UserLite {
  user_id: string;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
}

interface ActivityRow {
  activity_id: string;
  scope_type: ScopeType;
  direct_member_low: string | null;
  direct_member_high: string | null;
  group_id: string | null;
  adapter: ActivityAdapter;
  status: ActivityStatus;
  stream_call_id: string;
  host_user_id: string;
  controller_user_id: string;
  presenter_user_id: string | null;
  created_by: string;
  last_state: Record<string, unknown>;
  state_revision: number;
  created_at: Date | string;
  updated_at: Date | string;
  ended_at: Date | string | null;
}

interface ActivityParticipantRow extends UserLite {
  role: 'host' | 'participant';
  joined_at: Date | string;
  left_at: Date | string | null;
}

const adapterSchema = z.enum(['youtube', 'screen_share']);
const startSchema = z.discriminatedUnion('scope_type', [
  z.object({
    scope_type: z.literal('direct'),
    other_user_id: z.string().uuid(),
    adapter: adapterSchema,
    initial_video_id: z.string().trim().min(1).max(128).optional(),
  }),
  z.object({
    scope_type: z.literal('group'),
    group_id: z.string().uuid(),
    adapter: adapterSchema,
    initial_video_id: z.string().trim().min(1).max(128).optional(),
  }),
]);

const activeQuerySchema = z.discriminatedUnion('scope_type', [
  z.object({
    scope_type: z.literal('direct'),
    other_user_id: z.string().uuid(),
  }),
  z.object({
    scope_type: z.literal('group'),
    group_id: z.string().uuid(),
  }),
]);

const youtubeStateSchema = z.object({
  video_id: z.string().trim().min(1).max(128).nullable().optional(),
  position_sec: z.number().finite().min(0).max(24 * 60 * 60).optional(),
  playback_status: z.enum(['playing', 'paused', 'buffering']).optional(),
  playback_speed: z.number().finite().min(0.25).max(2).optional(),
  playlist_video_ids: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
  playlist_index: z.number().int().min(0).max(99).optional(),
}).strict();

const screenShareStateSchema = z.object({
  streaming: z.boolean().optional(),
}).strict();

const passControlSchema = z.object({
  target_user_id: z.string().uuid(),
});

const messageSchema = z.object({
  text: z.string().trim().min(1).max(1000),
});

function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function scopeId(row: ActivityRow): string {
  if (row.scope_type === 'group') return row.group_id!;
  return `${row.direct_member_low}:${row.direct_member_high}`;
}

function initialState(adapter: ActivityAdapter, creatorId: string, initialVideoId?: string): Record<string, unknown> {
  if (adapter === 'youtube') {
    return {
      video_id: initialVideoId ?? null,
      position_sec: 0,
      playback_status: 'paused',
      playback_speed: 1,
      playlist_video_ids: initialVideoId ? [initialVideoId] : [],
      playlist_index: 0,
      event_at_ms: Date.now(),
      updated_by: creatorId,
    };
  }
  return {
    presenter_user_id: creatorId,
    streaming: false,
    event_at_ms: Date.now(),
    updated_by: creatorId,
  };
}

function serializeActivity(row: ActivityRow, participants: ActivityParticipantRow[] = []) {
  return {
    activity_id: row.activity_id,
    scope_type: row.scope_type,
    scope_id: scopeId(row),
    group_id: row.group_id,
    direct_member_low: row.direct_member_low,
    direct_member_high: row.direct_member_high,
    adapter: row.adapter,
    status: row.status,
    stream_call_id: row.stream_call_id,
    host_user_id: row.host_user_id,
    controller_user_id: row.controller_user_id,
    presenter_user_id: row.presenter_user_id,
    state: row.last_state ?? {},
    state_revision: row.state_revision,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ended_at: row.ended_at,
    participants: participants.map((p) => ({
      user_id: p.user_id,
      handle: p.handle,
      display_name: p.display_name ?? p.handle,
      avatar_url: p.avatar_url,
      role: p.role,
      joined_at: p.joined_at,
      left_at: p.left_at,
      active: !p.left_at,
    })),
  };
}

async function notifyActivityPartyStarted(row: ActivityRow, creator: UserLite): Promise<void> {
  let recipientIds: string[] = [];
  if (row.scope_type === 'direct') {
    const otherId =
      row.direct_member_low === creator.user_id ? row.direct_member_high : row.direct_member_low;
    if (otherId) recipientIds = [otherId];
  } else {
    const members = await query<{ user_id: string }>(
      `SELECT user_id FROM group_members WHERE group_id = $1 AND user_id != $2`,
      [row.group_id, creator.user_id],
    );
    recipientIds = members.map((m) => m.user_id);
  }
  if (recipientIds.length === 0) return;

  const tokenRows = await query<{ user_id: string; fcm_token: string }>(
    `SELECT user_id, fcm_token FROM users
      WHERE user_id = ANY($1::uuid[]) AND fcm_token IS NOT NULL`,
    [recipientIds],
  );

  const title = row.adapter === 'screen_share' ? 'Screen Share Party' : 'Watch Together';
  const otherUserId =
    row.scope_type === 'direct'
      ? (row.direct_member_low === creator.user_id ? row.direct_member_high : row.direct_member_low)
      : null;

  await Promise.all(
    tokenRows.map((t) =>
      sendActivityPartyPush(t.fcm_token, {
        activityId: row.activity_id,
        adapter: row.adapter,
        scopeType: row.scope_type,
        scopeId: scopeId(row),
        groupId: row.group_id,
        otherUserId,
        fromUserId: creator.user_id,
        displayName: creator.display_name ?? creator.handle,
        handle: creator.handle,
        title,
      }),
    ),
  );
}

async function getUserLite(userId: string): Promise<UserLite> {
  const user = await queryOne<UserLite>(
    `SELECT user_id, handle, display_name, avatar_url FROM users WHERE user_id = $1 AND is_active = TRUE`,
    [userId],
  );
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
  return user;
}

async function getParticipants(activityId: string): Promise<ActivityParticipantRow[]> {
  return query<ActivityParticipantRow>(
    `SELECT u.user_id, u.handle, u.display_name, u.avatar_url,
            ap.role, ap.joined_at, ap.left_at
       FROM activity_participants ap
       JOIN users u ON u.user_id = ap.user_id
      WHERE ap.activity_id = $1
      ORDER BY ap.joined_at ASC`,
    [activityId],
  );
}

async function getActivity(activityId: string): Promise<ActivityRow> {
  const row = await queryOne<ActivityRow>(
    `SELECT * FROM activity_sessions WHERE activity_id = $1`,
    [activityId],
  );
  if (!row) throw new AppError(404, 'ACTIVITY_NOT_FOUND', 'Activity session not found.');
  return row;
}

async function assertDirectAllowed(selfId: string, otherId: string): Promise<[string, string]> {
  if (selfId === otherId) {
    throw new AppError(400, 'SELF_ACTIVITY', 'Cannot start an activity with yourself.');
  }

  await getUserLite(otherId);

  const blocked = await queryOne<{ connection_type: string }>(
    `SELECT connection_type
       FROM connections
      WHERE ((owner_id = $1 AND contact_id = $2) OR (owner_id = $2 AND contact_id = $1))
        AND connection_type = 'blocked'
      LIMIT 1`,
    [selfId, otherId],
  );
  if (blocked) {
    throw new AppError(403, 'ACTIVITY_BLOCKED', 'Activities are not available for this conversation.');
  }

  return orderedPair(selfId, otherId);
}

async function assertGroupMember(userId: string, groupId: string): Promise<void> {
  const membership = await queryOne<{ role: string }>(
    `SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2`,
    [groupId, userId],
  );
  if (!membership) {
    throw new AppError(403, 'NOT_A_MEMBER', 'You are not a member of this group.');
  }
}

async function assertActivityAccess(row: ActivityRow, userId: string): Promise<void> {
  if (row.scope_type === 'direct') {
    if (row.direct_member_low !== userId && row.direct_member_high !== userId) {
      throw new AppError(403, 'NOT_A_PARTICIPANT', 'You are not a participant in this activity.');
    }
    return;
  }
  await assertGroupMember(userId, row.group_id!);
}

async function assertActiveParticipant(activityId: string, userId: string): Promise<void> {
  const participant = await queryOne<{ user_id: string }>(
    `SELECT user_id FROM activity_participants
      WHERE activity_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [activityId, userId],
  );
  if (!participant) {
    throw new AppError(403, 'NOT_IN_PARTY', 'Join the activity before controlling it.');
  }
}

async function buildActiveQuery(params: z.infer<typeof activeQuerySchema>, userId: string): Promise<{ sql: string; args: string[] }> {
  if (params.scope_type === 'direct') {
    const [low, high] = await assertDirectAllowed(userId, params.other_user_id);
    return {
      sql: `SELECT * FROM activity_sessions
             WHERE scope_type = 'direct'
               AND direct_member_low = $1
               AND direct_member_high = $2
               AND status = 'active'
             ORDER BY created_at DESC
             LIMIT 5`,
      args: [low, high],
    };
  }

  await assertGroupMember(userId, params.group_id);
  return {
    sql: `SELECT * FROM activity_sessions
           WHERE scope_type = 'group'
             AND group_id = $1
             AND status = 'active'
           ORDER BY created_at DESC
           LIMIT 5`,
    args: [params.group_id],
  };
}

// ─── GET /activities/sessions/active ─────────────────────────────────────────

activitiesRouter.get('/sessions/active', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const params = activeQuerySchema.parse(req.query);
    const built = await buildActiveQuery(params, req.user!.sub);
    const rows = await query<ActivityRow>(built.sql, built.args);
    res.json({ ok: true, data: rows.map((row) => serializeActivity(row)) });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /activities/sessions ───────────────────────────────────────────────

activitiesRouter.post('/sessions', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = startSchema.parse(req.body);
    const creatorId = req.user!.sub;
    const creator = await getUserLite(creatorId);
    if (!isStreamConfigured()) {
      throw new AppError(503, 'STREAM_NOT_CONFIGURED', 'Activity parties are not available.');
    }

    await upsertStreamUser(creator);

    const streamCallId = `activity-${crypto.randomBytes(18).toString('base64url')}`;
    const state = initialState(body.adapter, creatorId, body.initial_video_id);

    const row = await withTransaction(async (client) => {
      let created: ActivityRow;
      if (body.scope_type === 'direct') {
        const [low, high] = await assertDirectAllowed(creatorId, body.other_user_id);
        const { rows } = await client.query<ActivityRow>(
          `INSERT INTO activity_sessions
             (scope_type, direct_member_low, direct_member_high, adapter, stream_call_id,
              host_user_id, controller_user_id, presenter_user_id, created_by, last_state)
           VALUES ('direct', $1, $2, $3, $4, $5, $5, $6, $5, $7)
           RETURNING *`,
          [
            low,
            high,
            body.adapter,
            streamCallId,
            creatorId,
            body.adapter === 'screen_share' ? creatorId : null,
            state,
          ],
        );
        created = rows[0];
      } else {
        await assertGroupMember(creatorId, body.group_id);
        const { rows } = await client.query<ActivityRow>(
          `INSERT INTO activity_sessions
             (scope_type, group_id, adapter, stream_call_id,
              host_user_id, controller_user_id, presenter_user_id, created_by, last_state)
           VALUES ('group', $1, $2, $3, $4, $4, $5, $4, $6)
           RETURNING *`,
          [
            body.group_id,
            body.adapter,
            streamCallId,
            creatorId,
            body.adapter === 'screen_share' ? creatorId : null,
            state,
          ],
        );
        created = rows[0];
      }

      await client.query(
        `INSERT INTO activity_participants (activity_id, user_id, role)
         VALUES ($1, $2, 'host')`,
        [created.activity_id, creatorId],
      );

      return created;
    });

    await rtdbCreateActivitySession({
      activity_id: row.activity_id,
      scope_type: row.scope_type,
      scope_id: scopeId(row),
      adapter: row.adapter,
      status: row.status,
      stream_call_id: row.stream_call_id,
      host_user_id: row.host_user_id,
      controller_user_id: row.controller_user_id,
      presenter_user_id: row.presenter_user_id,
      created_by: row.created_by,
      created_at: Date.now(),
      state_revision: row.state_revision,
      state: row.last_state ?? {},
      host: {
        user_id: creator.user_id,
        handle: creator.handle,
        display_name: creator.display_name ?? creator.handle,
        avatar_url: creator.avatar_url,
      },
    });

    notifyActivityPartyStarted(row, creator).catch(() => {});

    res.status(201).json({ ok: true, data: serializeActivity(row, [{
      ...creator,
      role: 'host',
      joined_at: row.created_at,
      left_at: null,
    }]) });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── GET /activities/sessions/:id ────────────────────────────────────────────

activitiesRouter.get('/sessions/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await getActivity(req.params.id);
    await assertActivityAccess(row, req.user!.sub);
    const participants = await getParticipants(row.activity_id);
    res.json({ ok: true, data: serializeActivity(row, participants) });
  } catch (err) {
    next(err);
  }
});

// ─── POST /activities/sessions/:id/join ──────────────────────────────────────

activitiesRouter.post('/sessions/:id/join', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const row = await getActivity(req.params.id);
    if (row.status !== 'active') throw new AppError(409, 'ACTIVITY_ENDED', 'This activity has ended.');
    await assertActivityAccess(row, userId);

    const user = await getUserLite(userId);
    await query(
      `INSERT INTO activity_participants (activity_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (activity_id, user_id)
       DO UPDATE SET left_at = NULL,
                     role = CASE WHEN activity_participants.role = 'host' THEN 'host' ELSE EXCLUDED.role END`,
      [row.activity_id, userId, row.host_user_id === userId ? 'host' : 'participant'],
    );

    await rtdbUpdateActivityParticipant(row.activity_id, {
      user_id: user.user_id,
      handle: user.handle,
      display_name: user.display_name ?? user.handle,
      avatar_url: user.avatar_url,
      role: row.host_user_id === userId ? 'host' : 'participant',
    }, true);

    const participants = await getParticipants(row.activity_id);
    res.json({ ok: true, data: serializeActivity(row, participants) });
  } catch (err) {
    next(err);
  }
});

// ─── POST /activities/sessions/:id/leave ─────────────────────────────────────

activitiesRouter.post('/sessions/:id/leave', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const activityId = req.params.id;

    // Pre-check access without a lock (fast path — access doesn't change during leave)
    const preCheck = await getActivity(activityId);
    await assertActivityAccess(preCheck, userId);
    const user = await getUserLite(userId);

    const { updated, ended } = await withTransaction(async (client) => {
      // Re-fetch with row lock to serialize concurrent leaves
      const { rows: locked } = await client.query<ActivityRow>(
        `SELECT * FROM activity_sessions WHERE activity_id = $1 FOR UPDATE`,
        [activityId]
      );
      if (!locked[0]) throw new AppError(404, 'ACTIVITY_NOT_FOUND', 'Activity session not found.');
      const row = locked[0];

      await client.query(
        `UPDATE activity_participants SET left_at = NOW()
          WHERE activity_id = $1 AND user_id = $2`,
        [activityId, userId]
      );

      const { rows: active } = await client.query<{ user_id: string }>(
        `SELECT user_id FROM activity_participants
          WHERE activity_id = $1 AND left_at IS NULL
          ORDER BY joined_at ASC`,
        [activityId]
      );

      if (active.length === 0) {
        const { rows } = await client.query<ActivityRow>(
          `UPDATE activity_sessions
              SET status = 'ended', ended_at = NOW()
            WHERE activity_id = $1
            RETURNING *`,
          [activityId]
        );
        return { updated: rows[0], ended: true };
      }

      const nextController = active.some((p) => p.user_id === row.controller_user_id)
        ? row.controller_user_id
        : active[0].user_id;
      const nextHost = active.some((p) => p.user_id === row.host_user_id)
        ? row.host_user_id
        : active[0].user_id;
      const nextPresenter = row.adapter === 'screen_share'
        ? (active.some((p) => p.user_id === row.presenter_user_id) ? row.presenter_user_id : nextController)
        : row.presenter_user_id;

      const { rows } = await client.query<ActivityRow>(
        `UPDATE activity_sessions
            SET host_user_id = $1,
                controller_user_id = $2,
                presenter_user_id = $3
          WHERE activity_id = $4
          RETURNING *`,
        [nextHost, nextController, nextPresenter, activityId]
      );
      await client.query(
        `UPDATE activity_participants
            SET role = CASE WHEN user_id = $1 THEN 'host' ELSE 'participant' END
          WHERE activity_id = $2`,
        [nextHost, activityId]
      );
      return { updated: rows[0], ended: false };
    });

    await rtdbUpdateActivityParticipant(activityId, {
      user_id: user.user_id,
      handle: user.handle,
      display_name: user.display_name ?? user.handle,
      avatar_url: user.avatar_url,
      role: preCheck.host_user_id === userId ? 'host' : 'participant',
    }, false);

    if (ended) {
      await rtdbEndActivitySession(activityId);
    } else {
      await rtdbUpdateActivityControl(activityId, {
        host_user_id: updated.host_user_id,
        controller_user_id: updated.controller_user_id,
        presenter_user_id: updated.presenter_user_id,
      });
    }

    res.json({ ok: true, data: serializeActivity(updated, await getParticipants(activityId)) });
  } catch (err) {
    next(err);
  }
});

// ─── POST /activities/sessions/:id/pass-control ──────────────────────────────

activitiesRouter.post('/sessions/:id/pass-control', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const { target_user_id } = passControlSchema.parse(req.body);
    const row = await getActivity(req.params.id);
    if (row.status !== 'active') throw new AppError(409, 'ACTIVITY_ENDED', 'This activity has ended.');
    await assertActivityAccess(row, userId);
    await assertActiveParticipant(row.activity_id, userId);

    if (row.host_user_id !== userId && row.controller_user_id !== userId) {
      throw new AppError(403, 'CONTROL_REQUIRED', 'Only the host or current controller can pass control.');
    }
    await assertActivityAccess(row, target_user_id);
    await assertActiveParticipant(row.activity_id, target_user_id);

    const updated = await queryOne<ActivityRow>(
      `UPDATE activity_sessions
          SET controller_user_id = $1,
              presenter_user_id = CASE WHEN adapter = 'screen_share' THEN $1 ELSE presenter_user_id END
        WHERE activity_id = $2
        RETURNING *`,
      [target_user_id, row.activity_id],
    );
    if (!updated) throw new AppError(404, 'ACTIVITY_NOT_FOUND', 'Activity session not found.');

    await rtdbUpdateActivityControl(row.activity_id, {
      controller_user_id: updated.controller_user_id,
      presenter_user_id: updated.presenter_user_id,
    });
    res.json({ ok: true, data: serializeActivity(updated, await getParticipants(row.activity_id)) });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /activities/sessions/:id/state ─────────────────────────────────────

activitiesRouter.post('/sessions/:id/state', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const row = await getActivity(req.params.id);
    if (row.status !== 'active') throw new AppError(409, 'ACTIVITY_ENDED', 'This activity has ended.');
    await assertActivityAccess(row, userId);
    await assertActiveParticipant(row.activity_id, userId);

    if (row.controller_user_id !== userId) {
      throw new AppError(403, 'CONTROL_REQUIRED', 'Only the active controller can update playback.');
    }

    const patch = row.adapter === 'youtube'
      ? youtubeStateSchema.parse(req.body)
      : screenShareStateSchema.parse(req.body);
    const nextState = {
      ...(row.last_state ?? {}),
      ...patch,
      ...(row.adapter === 'screen_share' ? { presenter_user_id: row.presenter_user_id ?? userId } : {}),
      event_at_ms: Date.now(),
      updated_by: userId,
    };

    const updated = await queryOne<ActivityRow>(
      `UPDATE activity_sessions
          SET last_state = $1::jsonb,
              state_revision = state_revision + 1
        WHERE activity_id = $2
        RETURNING *`,
      [JSON.stringify(nextState), row.activity_id],
    );
    if (!updated) throw new AppError(404, 'ACTIVITY_NOT_FOUND', 'Activity session not found.');

    await rtdbUpdateActivityState(row.activity_id, updated.last_state ?? {}, updated.state_revision);
    res.json({ ok: true, data: serializeActivity(updated, await getParticipants(row.activity_id)) });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /activities/sessions/:id/messages ──────────────────────────────────

activitiesRouter.post('/sessions/:id/messages', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const { text } = messageSchema.parse(req.body);
    const row = await getActivity(req.params.id);
    if (row.status !== 'active') throw new AppError(409, 'ACTIVITY_ENDED', 'This activity has ended.');
    await assertActivityAccess(row, userId);
    await assertActiveParticipant(row.activity_id, userId);

    const user = await getUserLite(userId);
    const messageId = await rtdbAppendActivityMessage(row.activity_id, {
      user_id: user.user_id,
      handle: user.handle,
      display_name: user.display_name ?? user.handle,
      text,
    });

    res.status(201).json({ ok: true, data: { message_id: messageId } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});
