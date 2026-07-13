import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { query, queryOne } from '@trustroute/shared';
import type { CallRow } from '@trustroute/shared';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
// callLimiter intentionally not imported — trusted contacts bypass all rate limits
import { trackEvent } from '../services/behavior';
import { sendIncomingCallPush, sendCallCancelledPush, rtdbCreateCall, rtdbUpdateStatus } from '../services/fcm';
import {
  createOrReuseDirectCall,
  initiateSchema,
  isStreamBackedCall,
  resolveDirectCallTarget,
  STREAM_CALL_ROOM_MARKER,
  streamPrepareSchema,
} from '../services/directCallGates';
import {
  createUserToken,
  getStreamApiKey,
  isStreamConfigured,
  upsertStreamUser,
} from '../services/stream';
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

// ─── GET /calls/stream-token ──────────────────────────────────────────────────
// Video-capable Stream token (same app/credentials as chat).

callsRouter.get('/stream-token', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isStreamConfigured()) {
      throw new AppError(503, 'STREAM_NOT_CONFIGURED', 'Stream Video is not configured on the server.');
    }
    const me = await queryOne<{ user_id: string; handle: string; display_name: string | null; avatar_url: string | null }>(
      `SELECT user_id, handle, display_name, avatar_url FROM users WHERE user_id = $1`,
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
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /calls/stream/prepare ───────────────────────────────────────────────
// TrustRoute policy gates + Postgres call row. Client rings via Stream Video.

callsRouter.post('/stream/prepare', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isStreamConfigured()) {
      throw new AppError(503, 'STREAM_NOT_CONFIGURED', 'Stream Video is not configured on the server.');
    }

    const body = streamPrepareSchema.parse(req.body);
    const callerId = req.user!.sub;
    const { calleeId, channelId, callType } = await resolveDirectCallTarget(callerId, body);

    const { call, reused } = await createOrReuseDirectCall(
      callerId,
      calleeId,
      channelId,
      callType,
      STREAM_CALL_ROOM_MARKER,
    );

    if (!reused) {
      setImmediate(() => {
        trackEvent(callerId, 'call_initiated', calleeId, {
          call_id: call.call_id,
          call_type: callType,
          stream: true,
          video: body.video,
        }).catch(() => {});

        // Ensure both parties exist in Stream for ringing + push.
        void (async () => {
          try {
            const users = await query<{ user_id: string; handle: string; display_name: string | null; avatar_url: string | null }>(
              `SELECT user_id, handle, display_name, avatar_url FROM users WHERE user_id = ANY($1::uuid[])`,
              [[callerId, calleeId]],
            );
            await Promise.all(users.map((u) => upsertStreamUser(u)));
          } catch { /* best effort */ }
        })();
      });
    }

    res.status(reused ? 200 : 201).json({
      ok: true,
      data: {
        call_id: call.call_id,
        video: body.video,
        status: call.status,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /calls/initiate ─────────────────────────────────────────────────────
// Legacy LiveKit path — kept for reachability / rollback. Mobile 1:1 uses /stream/prepare.

// NOTE: callLimiter removed — trusted contacts must have zero restrictions.
// Rate limiting for unknown callers is handled inside the handler after
// connection type is resolved.
callsRouter.post('/initiate', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = initiateSchema.parse(req.body);
    const callerId = req.user!.sub;
    const { calleeId, channelId, callType } = await resolveDirectCallTarget(callerId, body);

    const webrtcRoomId = crypto.randomBytes(16).toString('base64url');
    const { call, reused } = await createOrReuseDirectCall(
      callerId,
      calleeId,
      channelId,
      callType,
      webrtcRoomId,
    );

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

    // Legacy LiveKit path only — Stream owns media state for stream-backed calls.
    if (!isStreamBackedCall(call.webrtc_room_id)) {
      rtdbUpdateStatus(req.params.id, 'answered').catch(() => {});
    }

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

    // Legacy LiveKit path — Stream-backed calls skip RTDB + custom FCM cancel.
    if (!isStreamBackedCall(call.webrtc_room_id)) {
      rtdbUpdateStatus(req.params.id, finalStatus as any).catch(() => {});

      if (finalStatus === 'missed' || finalStatus === 'declined' || finalStatus === 'failed') {
        const prevStatus = (updatedCall as any).prev_status as string;
        if (prevStatus === 'ringing' || prevStatus === 'initiated') {
          const notifyUserId = req.user!.sub === call.caller_id ? call.callee_id : call.caller_id;
          setImmediate(async () => {
            try {
              const notifyUser = await queryOne<{ fcm_token: string | null }>(
                `SELECT fcm_token FROM users WHERE user_id = $1`, [notifyUserId],
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
      logger.warn(
        'calls',
        `LiveKit NOT configured (url=${!!livekitUrl}, key=${!!apiKey}, secret=${!!apiSecret}) — ` +
          `calls cannot connect. Set LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET.`,
      );
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
