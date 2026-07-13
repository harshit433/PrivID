import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction, getRedis } from '@trustroute/shared';
import type { CallRow, ConnectionRow, ReachabilityChannelRow } from '@trustroute/shared';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
// callLimiter intentionally not imported — trusted contacts bypass all rate limits
import { trackEvent } from '../services/behavior';
import { sendIncomingCallPush, sendCallCancelledPush, rtdbCreateCall, rtdbUpdateStatus } from '../services/fcm';
import { logger } from '../utils/logger';
import crypto from 'crypto';
import { AccessToken } from 'livekit-server-sdk';
import { Queue } from 'bullmq';

// ─── BullMQ ring-timeout queue (lazy-initialized) ────────────────────────────
let _ringQueue: Queue | null = null;
function getRingTimeoutQueue(): Queue {
  if (!_ringQueue) {
    _ringQueue = new Queue('ring-timeout', {
      connection: { url: process.env.REDIS_PRIVATE_URL ?? process.env.REDIS_URL ?? 'redis://localhost:6379' },
    });
  }
  return _ringQueue;
}

export const callsRouter = Router();

// ─── Dynamic cooldown helper ──────────────────────────────────────────────────
// Cooldown escalates with consecutive unanswered calls; resets when answered.
//   0 previous / last answered → 0 ms
//   1 unanswered               → 5 min
//   2 consecutive unanswered   → 20 min
//   3+ consecutive unanswered  → 2 hr
function dynamicCooldownMs(calls: Array<{ status: string }>): number {
  if (calls.length === 0) return 0;
  const last = calls[0];
  if (last.status === 'answered' || last.status === 'ended') return 0;
  let consecutive = 0;
  for (const c of calls) {
    if (c.status === 'answered' || c.status === 'ended') break;
    consecutive++;
  }
  if (consecutive === 1) return 5 * 60 * 1000;
  if (consecutive === 2) return 20 * 60 * 1000;
  return 2 * 60 * 60 * 1000;
}

// ─── POST /calls/initiate ─────────────────────────────────────────────────────

const initiateSchema = z.object({
  callee_id: z.string().uuid().optional(),
  channel_token: z.string().optional(),
}).refine((d) => d.callee_id || d.channel_token, {
  message: 'Either callee_id or channel_token is required.',
});

// NOTE: callLimiter removed — trusted contacts must have zero restrictions.
// Rate limiting for unknown callers is handled inside the handler after
// connection type is resolved.
callsRouter.post('/initiate', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = initiateSchema.parse(req.body);
    const callerId = req.user!.sub;

    let calleeId: string;
    let channelId: string | null = null;
    let callType: 'direct' | 'reachability' = 'direct';

    if (body.channel_token) {
      // Reachability call — resolve channel
      const channel = await queryOne<ReachabilityChannelRow>(
        `SELECT * FROM reachability_channels WHERE token = $1 AND status = 'active'`,
        [body.channel_token]
      );
      if (!channel) throw new AppError(404, 'CHANNEL_NOT_FOUND', 'Reachability link not found or inactive.');
      if (channel.expires_at && new Date() > channel.expires_at) {
        throw new AppError(410, 'CHANNEL_EXPIRED', 'This reachability link has expired.');
      }

      // Check daily usage
      const today = new Date().toISOString().slice(0, 10);
      const [{ count }] = await query<{ count: string }>(
        `SELECT COUNT(*) as count FROM channel_usage_log
         WHERE channel_id = $1 AND action = 'call_attempted' AND created_at::date = $2::date`,
        [channel.channel_id, today]
      );
      if (parseInt(count) >= channel.daily_limit) {
        throw new AppError(429, 'DAILY_LIMIT_REACHED', 'Daily call limit for this link has been reached.');
      }

      calleeId = channel.owner_id;
      channelId = channel.channel_id;
      callType = 'reachability';
    } else {
      calleeId = body.callee_id!;

      if (calleeId === callerId) {
        throw new AppError(400, 'SELF_CALL', 'You cannot call yourself.');
      }

      // Fetch caller status + callee connection/settings in one parallel round-trip.
      // All three queries are independent of each other — no reason to run serially.
      // callerConn (the caller's OWN record toward this callee) is only needed when
      // the caller has an active restriction; it's fetched separately below only then.
      const [callerStatus, calleeConn, calleeUser, callerToCalleeConn] = await Promise.all([
        queryOne<{ is_under_review: boolean; call_restriction_until: Date | null }>(
          `SELECT is_under_review, call_restriction_until FROM users WHERE user_id = $1`,
          [callerId],
        ),
        queryOne<ConnectionRow>(
          `SELECT * FROM connections WHERE owner_id = $1 AND contact_id = $2`,
          [calleeId, callerId],
        ),
        queryOne<{ discovery_mode: string }>(
          `SELECT discovery_mode FROM users WHERE user_id = $1`,
          [calleeId],
        ),
        queryOne<{ connection_type: string }>(
          `SELECT connection_type FROM connections WHERE owner_id = $1 AND contact_id = $2`,
          [callerId, calleeId],
        ),
      ]);

      if (callerStatus?.is_under_review) {
        throw new AppError(403, 'ACCOUNT_UNDER_REVIEW',
          'Your account is under review. You cannot initiate new calls until the review is resolved.');
      }

      // Restriction check — only applies to non-trusted callees
      const restriction = callerStatus?.call_restriction_until;
      if (restriction && new Date(restriction) > new Date()) {
        const isTrustedByMe =
          callerToCalleeConn?.connection_type === 'trusted' ||
          callerToCalleeConn?.connection_type === 'temporary';

        if (!isTrustedByMe) {
          const RESTRICTION_DAILY_CAP = 5;
          const [restrictedCallCount] = await query<{ count: string }>(
            `SELECT COUNT(*)::text AS count
               FROM calls c
              WHERE c.caller_id = $1
                AND c.created_at > NOW() - INTERVAL '1 day'
                AND NOT EXISTS (
                  SELECT 1 FROM connections cc
                  WHERE cc.owner_id = c.caller_id
                    AND cc.contact_id = c.callee_id
                    AND cc.connection_type IN ('trusted','temporary')
                )`,
            [callerId],
          );

          if (parseInt(restrictedCallCount?.count ?? '0') >= RESTRICTION_DAILY_CAP) {
            throw new AppError(
              429,
              'ACCOUNT_RESTRICTED',
              `Your account is under a temporary restriction. ` +
              `You can make up to ${RESTRICTION_DAILY_CAP} calls to new contacts per day. ` +
              `Calls to your trusted contacts are unaffected. ` +
              `Restriction lifts on ${new Date(restriction).toLocaleDateString('en-IN')}.`,
            );
          }
        }
      }

      const connType = calleeConn?.connection_type ?? 'unknown';

      // Private mode — only trusted/temporary connections can call
      if (calleeUser?.discovery_mode === 'private' && connType === 'unknown') {
        throw new AppError(403, 'DISCOVERY_PRIVATE', 'This person is not accepting calls from unknown contacts.');
      }

      // Hard block — callee blocked caller
      if (connType === 'blocked') {
        throw new AppError(403, 'CALLER_BLOCKED', 'You cannot call this person.');
      }

      // Hard block — caller blocked callee
      if (callerToCalleeConn?.connection_type === 'blocked') {
        throw new AppError(403, 'CALL_BLOCKED', 'You cannot call someone you have blocked.');
      }

      // Temporary — expired access
      if (connType === 'temporary' && calleeConn?.temporary_expires_at) {
        if (new Date() > new Date(calleeConn.temporary_expires_at)) {
          throw new AppError(403, 'TEMPORARY_EXPIRED', 'Your temporary access to this person has expired.');
        }
      }

      // Temporary / unknown — daily call limit (server-side enforcement)
      if (connType === 'temporary' || connType === 'unknown') {
        const dailyLimit = connType === 'temporary'
          ? (calleeConn?.daily_call_limit ?? 5)
          : 4; // mirrors UNKNOWN_MAX_ATTEMPTS on the client

        const [countRow] = await query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM calls
           WHERE caller_id = $1 AND callee_id = $2
             AND created_at >= CURRENT_DATE`,
          [callerId, calleeId],
        );
        if (parseInt(countRow.count, 10) >= dailyLimit) {
          throw new AppError(429, 'DAILY_LIMIT_REACHED', 'Daily call limit reached for this contact. Try again tomorrow.');
        }

        // Unknown callers only: global rate limit (30 unknown calls / 10 min)
        // This is the ONLY rate limit applied — trusted contacts are never throttled.
        if (connType === 'unknown') {
          try {
            const redis = getRedis();
            const rlKey = `call_unknown:${callerId}`;
            const pipeline = redis.pipeline();
            pipeline.incr(rlKey);
            pipeline.expire(rlKey, 600, 'NX'); // NX = only set expiry if not already set (atomic)
            const results = await pipeline.exec();
            const count = (results?.[0]?.[1] as number) ?? 0;
            if (count > 30) {
              throw new AppError(429, 'CALL_RATE_LIMITED',
                'Too many calls to new contacts. Please wait a few minutes.');
            }
          } catch (e) {
            if (e instanceof AppError) throw e;
            // Redis unavailable — fail open
          }
        }

        // Unknown — dynamic cooldown based on answer history
        if (connType === 'unknown') {
          const recentCalls = await query<{ status: string; created_at: string }>(
            `SELECT status, created_at FROM calls
             WHERE caller_id = $1 AND callee_id = $2
             ORDER BY created_at DESC LIMIT 5`,
            [callerId, calleeId],
          );
          const cooldownMs = dynamicCooldownMs(recentCalls);
          if (recentCalls.length > 0 && cooldownMs > 0) {
            const elapsed = Math.max(0, Date.now() - new Date(recentCalls[0].created_at).getTime());
            if (elapsed < cooldownMs) {
              const remainSec = Math.ceil((cooldownMs - elapsed) / 1000);
              const msg = remainSec < 90
                ? `Please wait ${remainSec} more second${remainSec === 1 ? '' : 's'} before calling again.`
                : `Please wait ${Math.ceil(remainSec / 60)} more minute${Math.ceil(remainSec / 60) === 1 ? '' : 's'} before calling again.`;
              throw new AppError(429, 'COOLDOWN_ACTIVE', msg);
            }
          }
        }
      }
    }

    const webrtcRoomId = crypto.randomBytes(16).toString('base64url');

    const { call, reused } = await withTransaction<{ call: CallRow; reused: boolean }>(async (client) => {
      // Serialise concurrent initiation attempts from the same caller so a
      // double-tap / retry can't create two competing invites.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`call_init_${callerId}`]);

      const ACTIVE = `('initiated','ringing','answered')`;

      // ── Idempotency ────────────────────────────────────────────────────────
      // If this caller already has a live invite to THIS callee, return it
      // instead of erroring. This is what makes initiate safe to call twice:
      // the second call is a no-op that re-joins the same room, so we never
      // busy-conflict against our own ring or orphan the first invite.
      const existing = await client.query<CallRow>(
        `SELECT * FROM calls
          WHERE caller_id = $1 AND callee_id = $2 AND status IN ${ACTIVE}
          ORDER BY created_at DESC LIMIT 1`,
        [callerId, calleeId],
      );
      if ((existing.rowCount ?? 0) > 0) {
        return { call: existing.rows[0], reused: true };
      }

      // ── Callee busy (with a DIFFERENT caller) ────────────────────────────────
      const activeCallee = await client.query(
        `SELECT 1 FROM calls
          WHERE callee_id = $1 AND caller_id <> $2 AND status IN ${ACTIVE} LIMIT 1`,
        [calleeId, callerId],
      );
      if ((activeCallee.rowCount ?? 0) > 0) {
        throw new AppError(409, 'CALLEE_BUSY', 'The person you are calling is already on a call.');
      }

      // ── Caller busy (in ANY other call, as caller or callee) ─────────────────
      const activeCaller = await client.query(
        `SELECT 1 FROM calls
          WHERE (caller_id = $1 OR callee_id = $1)
            AND status IN ${ACTIVE}
            AND NOT (caller_id = $1 AND callee_id = $2)
          LIMIT 1`,
        [callerId, calleeId],
      );
      if ((activeCaller.rowCount ?? 0) > 0) {
        throw new AppError(409, 'CALLER_BUSY', 'You already have an active call in progress.');
      }

      const { rows } = await client.query<CallRow>(
        `INSERT INTO calls (caller_id, callee_id, call_type, channel_id, webrtc_room_id, status)
         VALUES ($1, $2, $3, $4, $5, 'ringing')
         RETURNING *`,
        [callerId, calleeId, callType, channelId, webrtcRoomId]
      );

      if (channelId) {
        await client.query(
          `INSERT INTO channel_usage_log (channel_id, caller_id, action) VALUES ($1, $2, 'call_attempted')`,
          [channelId, callerId]
        );
        await client.query(
          `UPDATE reachability_channels SET use_count = use_count + 1 WHERE channel_id = $1`,
          [channelId]
        );
      }

      return { call: rows[0], reused: false };
    });

    // A reused invite already fired its push / ring-timeout / RTDB write on the
    // first initiate — return it immediately without duplicating side effects
    // (avoids double-ringing the callee).
    if (reused) {
      res.status(201).json({
        ok: true,
        data: {
          call_id: call.call_id,
          webrtc_room_id: call.webrtc_room_id,
          status: call.status,
        },
      });
      return;
    }

    // ── Post-response work: behavior tracking + RTDB + FCM ───────────────────
    // None of these affect the caller's response — move them off the hot path.
    // setImmediate fires after the current event-loop tick (i.e. after the HTTP
    // response is flushed), so the caller sees the 201 immediately.
    setImmediate(() => {
      trackEvent(callerId, 'call_initiated', calleeId, { call_id: call.call_id, call_type: callType })
        .catch(() => {});
    });

    // ── RTDB: write initial call state (fire-and-forget) ─────────────────────
    rtdbCreateCall(call.call_id, callerId, calleeId).catch(() => {});

    // ── Server-side ring timeout (45s) — persistent via BullMQ ─────────────
    // Using a delayed BullMQ job instead of setTimeout so the timeout survives
    // server restarts and rolling deploys.
    getRingTimeoutQueue().add(
      'ring-timeout',
      { call_id: call.call_id },
      { delay: 45_000, jobId: `ring-${call.call_id}`, removeOnComplete: true, removeOnFail: 10 },
    ).catch((err: any) => logger.warn('calls', 'Failed to enqueue ring timeout:', err?.message));

    // ── FCM push to callee ────────────────────────────────────────────────────
    // Single query: get caller info + callee's FCM token + connection type
    ;(async () => {
      try {
        const [caller, callee, conn] = await Promise.all([
          queryOne<{ handle: string; display_name: string | null; trust_tier: string; trust_score: number; avatar_url: string | null }>(
            `SELECT handle, display_name, trust_tier, trust_score, avatar_url FROM users WHERE user_id = $1`,
            [callerId],
          ),
          queryOne<{ fcm_token: string | null }>(
            `SELECT fcm_token FROM users WHERE user_id = $1`,
            [calleeId],
          ),
          queryOne<{ connection_type: string }>(
            `SELECT connection_type FROM connections WHERE owner_id = $1 AND contact_id = $2`,
            [calleeId, callerId],
          ),
        ]);

        if (!callee?.fcm_token) {
          logger.warn('calls', `No FCM token for callee ${calleeId} — push skipped`);
          return;
        }
        if (!caller) return;

        await sendIncomingCallPush(callee.fcm_token, {
          callId:          call.call_id,
          webrtcRoomId:    call.webrtc_room_id ?? '',
          fromUserId:      callerId,
          handle:          caller.handle,
          displayName:     caller.display_name ?? caller.handle,
          avatarUrl:       caller.avatar_url   ?? undefined,
          trustTier:       caller.trust_tier,
          trustScore:      caller.trust_score,
          connectionType:  conn?.connection_type,
        });
        logger.debug('calls', `FCM push sent to ${calleeId} for call ${call.call_id}`);
      } catch (err: any) {
        logger.warn('calls', 'FCM push error:', err?.message);
      }
    })();

    res.status(201).json({
      ok: true,
      data: {
        call_id: call.call_id,
        webrtc_room_id: call.webrtc_room_id,
        status: call.status,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /calls/:id/answer ───────────────────────────────────────────────────

callsRouter.post('/:id/answer', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const call = await queryOne<CallRow>(
      `UPDATE calls
          SET status = 'answered', started_at = NOW()
        WHERE call_id = $1
          AND callee_id = $2
          AND status IN ('initiated', 'ringing')
        RETURNING *`,
      [req.params.id, req.user!.sub]
    );

    if (!call) {
      // Either doesn't exist, wrong callee, or already answered/ended
      throw new AppError(409, 'CALL_NOT_ANSWERABLE', 'Call is no longer available.');
    }

    // Signal caller instantly — their OutboundCallingScreen transitions to active
    rtdbUpdateStatus(req.params.id, 'answered').catch(() => {});

    res.json({ ok: true, data: { call_id: call.call_id, status: call.status, webrtc_room_id: call.webrtc_room_id } });
  } catch (err) {
    next(err);
  }
});

// ─── POST /calls/:id/end ──────────────────────────────────────────────────────

callsRouter.post('/:id/end', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    // 'missed' = caller cancelled / timeout; added alongside declined/ended/failed
    const { reason } = z.object({
      reason: z.enum(['declined', 'ended', 'failed', 'missed']).default('ended'),
    }).parse(req.body);

    const updatedCall = await queryOne<CallRow & { prev_status: string }>(
      `WITH prev AS (
         SELECT status FROM calls
         WHERE call_id = $3
           AND (caller_id = $2 OR callee_id = $2)
           AND status NOT IN ('ended','declined','missed','failed')
         FOR UPDATE
       )
       UPDATE calls SET
         status = CASE
           WHEN prev.status = 'answered'::call_status THEN 'ended'::call_status
           ELSE $1::call_status
         END,
         ended_at = NOW(),
         duration_seconds = CASE
           WHEN started_at IS NOT NULL
           THEN EXTRACT(EPOCH FROM (NOW() - started_at))::int
           ELSE NULL
         END
       FROM prev
       WHERE calls.call_id = $3
       RETURNING calls.*, prev.status AS prev_status`,
      [reason, req.user!.sub, req.params.id]
    );

    if (!updatedCall) {
      throw new AppError(409, 'CALL_ALREADY_ENDED', 'Call has already ended or was not found.');
    }

    const call = updatedCall;
    const finalStatus = updatedCall.status as string;
    const updated = updatedCall;

    // ── RTDB: signal the other device instantly ───────────────────────────────
    // This fires in < 100ms on the other device's active listener.
    // No polling needed anywhere in the app.
    rtdbUpdateStatus(req.params.id, finalStatus as any).catch(() => {});

    // Send cancellation push to the other party so background/killed devices dismiss the notification
    // Include `failed` — caller may abort after initiate if media connect fails while callee is still ringing.
    if (finalStatus === 'missed' || finalStatus === 'declined' || finalStatus === 'failed') {
      const prevStatus = (updatedCall as any).prev_status as string;
      if (prevStatus === 'ringing' || prevStatus === 'initiated') {
        // The party who did NOT end the call needs the push
        const notifyUserId = req.user!.sub === call.caller_id ? call.callee_id : call.caller_id;
        setImmediate(async () => {
          try {
            const notifyUser = await queryOne<{ fcm_token: string | null }>(
              `SELECT fcm_token FROM users WHERE user_id = $1`, [notifyUserId]
            );
            if (notifyUser?.fcm_token) {
              await sendCallCancelledPush(
                notifyUser.fcm_token,
                req.params.id,
                finalStatus as 'declined' | 'missed' | 'failed',
              );
            }
          } catch { /* best effort */ }
        });
      }
    }

    res.json({ ok: true, data: { call_id: updated.call_id, status: updated.status, duration_seconds: updated.duration_seconds } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /calls/:id/livekit-token ───────────────────────────────────────────
// Returns a short-lived LiveKit JWT for the requesting participant to join
// the call room.  Both caller and callee call this independently.

callsRouter.post('/:id/livekit-token', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const call = await queryOne<CallRow>(
      `SELECT * FROM calls WHERE call_id = $1 AND (caller_id = $2 OR callee_id = $2)`,
      [req.params.id, req.user!.sub],
    );
    if (!call) throw new AppError(404, 'CALL_NOT_FOUND', 'Call not found.');
    if (!['initiated', 'ringing', 'answered'].includes(call.status)) {
      throw new AppError(409, 'CALL_ENDED', 'Call is no longer active.');
    }

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const livekitUrl = process.env.LIVEKIT_URL;
    if (!apiKey || !apiSecret || !livekitUrl) {
      if (process.env.NODE_ENV === 'production') {
        throw new AppError(503, 'CALLS_UNAVAILABLE', 'Calling is briefly unavailable.');
      }
    }
    const resolvedKey = apiKey ?? 'devkey';
    const resolvedSecret = apiSecret ?? 'devsecret';
    const resolvedUrl = livekitUrl ?? 'ws://localhost:7880';

    const user = await queryOne<{ handle: string; display_name: string }>(
      `SELECT handle, display_name FROM users WHERE user_id = $1`,
      [req.user!.sub],
    );

    const at = new AccessToken(resolvedKey, resolvedSecret, {
      identity: req.user!.sub,
      name: user?.display_name ?? user?.handle ?? req.user!.sub,
      ttl: '15m',
    });
    at.addGrant({
      roomJoin: true,
      room: call.webrtc_room_id ?? undefined,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const token = await at.toJwt();
    res.json({ ok: true, data: { token, url: resolvedUrl } });
  } catch (err) {
    next(err);
  }
});

// ─── GET /calls/pending ──────────────────────────────────────────────────────
// Returns calls where I'm the callee and status is initiated or ringing

callsRouter.get('/pending', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await query(
      `SELECT
         c.call_id, c.call_type, c.status, c.created_at, c.webrtc_room_id,
         caller.user_id      AS caller_user_id,
         caller.handle       AS caller_handle,
         caller.display_name AS caller_name,
         caller.trust_tier   AS trust_tier,
         caller.trust_score  AS trust_score,
         caller.avatar_url   AS caller_avatar_url,
         conn.connection_type
       FROM calls c
       JOIN users caller ON caller.user_id = c.caller_id
       LEFT JOIN connections conn
         ON conn.owner_id = $1 AND conn.contact_id = c.caller_id
       WHERE c.callee_id = $1
         AND c.status IN ('initiated', 'ringing')
       ORDER BY c.created_at DESC
       LIMIT 5`,
      [req.user!.sub]
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// ─── GET /calls/history ───────────────────────────────────────────────────────
// Must be declared BEFORE /:id to prevent Express matching 'history' as an id.

callsRouter.get('/history', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string ?? '20'), 50);
    const offset = parseInt(req.query.offset as string ?? '0');

    const rows = await query<{ total_count: number }>(
      `SELECT
         c.call_id, c.call_type, c.status, c.started_at, c.ended_at, c.duration_seconds,
         c.caller_id, c.callee_id,
         caller.handle AS caller_handle, caller.display_name AS caller_name,
         caller.avatar_url AS caller_avatar_url,
         callee.handle AS callee_handle, callee.display_name AS callee_name,
         callee.avatar_url AS callee_avatar_url,
         CASE WHEN c.caller_id = $1 THEN 'outgoing' ELSE 'incoming' END AS direction,
         COUNT(*) OVER()::int AS total_count
       FROM calls c
       JOIN users caller ON caller.user_id = c.caller_id
       JOIN users callee ON callee.user_id = c.callee_id
       WHERE c.caller_id = $1 OR c.callee_id = $1
       ORDER BY c.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user!.sub, limit, offset]
    );

    const total = rows[0]?.total_count ?? 0;
    res.json({ ok: true, data: rows, meta: { total, limit, offset } });
  } catch (err) {
    next(err);
  }
});

// ─── GET /calls/:id ───────────────────────────────────────────────────────────

callsRouter.get('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const call = await queryOne(
      `SELECT
         c.call_id, c.call_type, c.status, c.started_at, c.ended_at, c.duration_seconds,
         c.caller_id, c.callee_id, c.webrtc_room_id, c.channel_id, c.created_at,
         caller.handle       AS caller_handle,
         caller.display_name AS caller_name,
         caller.trust_tier   AS caller_trust_tier,
         caller.trust_score  AS caller_trust_score,
         callee.handle       AS callee_handle,
         callee.display_name AS callee_name,
         CASE WHEN c.caller_id = $2 THEN 'outgoing' ELSE 'incoming' END AS direction
       FROM calls c
       JOIN users caller ON caller.user_id = c.caller_id
       JOIN users callee ON callee.user_id = c.callee_id
       WHERE c.call_id = $1
         AND (c.caller_id = $2 OR c.callee_id = $2)`,
      [req.params.id, req.user!.sub]
    );
    if (!call) throw new AppError(404, 'CALL_NOT_FOUND', 'Call not found.');
    res.json({ ok: true, data: call });
  } catch (err) {
    next(err);
  }
});

// ─── POST /calls/:id/quality ──────────────────────────────────────────────────
//
// Submit a quality report for a completed call.
//
// The data feeds the ML pipeline:
//   • Very short avg_duration or high packet_loss correlates with robocall spam.
//   • High MOS scores for a user's calls contribute positively to their
//     behavioural feature vector (calls_avg_quality).
//
// Constraints:
//   • Caller or callee only — no third-party reports.
//   • Call must be in a terminal state (ended | missed | declined).
//   • One report per (call_id, user_id) — duplicate submissions are rejected.
//   • All metric fields are optional; submitting an empty object is allowed
//     (records that the report was submitted but no metrics were available).

const qualitySchema = z.object({
  mos_score:       z.number().min(1.0).max(5.0).optional(),
  packet_loss_pct: z.number().min(0).max(100).optional(),
  jitter_ms:       z.number().int().min(0).optional(),
  rtt_ms:          z.number().int().min(0).optional(),
});

callsRouter.post('/:id/quality', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const metrics = qualitySchema.parse(req.body);
    const myId    = req.user!.sub;

    // Verify the call exists and the requester was a participant
    const call = await queryOne<{ caller_id: string; callee_id: string; status: string }>(
      `SELECT caller_id, callee_id, status FROM calls WHERE call_id = $1`,
      [id],
    );

    if (!call) throw new AppError(404, 'CALL_NOT_FOUND', 'Call not found.');

    if (call.caller_id !== myId && call.callee_id !== myId) {
      throw new AppError(403, 'FORBIDDEN', 'You were not a participant in this call.');
    }

    // Only accept reports for calls that have ended
    const terminalStatuses = ['ended', 'missed', 'declined', 'failed'];
    if (!terminalStatuses.includes(call.status)) {
      throw new AppError(409, 'CALL_NOT_ENDED', 'Quality reports are only accepted after a call ends.');
    }

    // One report per participant per call — duplicate = 409 (atomic upsert)
    const [report] = await query<{ report_id: string }>(
      `INSERT INTO call_quality_reports (call_id, user_id, mos_score, packet_loss_pct, jitter_ms, rtt_ms)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (call_id, user_id) DO NOTHING
       RETURNING report_id`,
      [id, myId, metrics.mos_score ?? null, metrics.packet_loss_pct ?? null,
       metrics.jitter_ms ?? null, metrics.rtt_ms ?? null],
    );
    if (!report) {
      throw new AppError(409, 'ALREADY_SUBMITTED', 'Quality report already submitted for this call.');
    }

    res.status(201).json({ ok: true, data: { report_id: report.report_id } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});
