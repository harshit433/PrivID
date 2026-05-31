import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '@privid/shared';
import type { CallRow, ConnectionRow, ReachabilityChannelRow } from '@privid/shared';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
// callLimiter intentionally not imported — trusted contacts bypass all rate limits
import { trackEvent } from '../services/behavior';
import { sendIncomingCallPush } from '../services/fcm';
import crypto from 'crypto';
import { AccessToken } from 'livekit-server-sdk';

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

      // Block callers whose trust score has dropped below the review threshold
      const callerStatus = await queryOne<{ is_under_review: boolean }>(
        `SELECT is_under_review FROM users WHERE user_id = $1`,
        [callerId],
      );
      if (callerStatus?.is_under_review) {
        throw new AppError(403, 'ACCOUNT_UNDER_REVIEW',
          'Your account is under review. You cannot initiate new calls until the review is resolved.');
      }

      // Check caller's permission from callee's perspective
      // Check callee's connection record for the caller (direct calls only)
      const [calleeConn, calleeUser] = await Promise.all([
        queryOne<ConnectionRow>(
          `SELECT * FROM connections WHERE owner_id = $1 AND contact_id = $2`,
          [calleeId, callerId],
        ),
        queryOne<{ discovery_mode: string }>(
          `SELECT discovery_mode FROM users WHERE user_id = $1`,
          [calleeId],
        ),
      ]);

      const connType = calleeConn?.connection_type ?? 'unknown';

      // Private mode — only trusted/temporary connections can call
      if (calleeUser?.discovery_mode === 'private' && connType === 'unknown') {
        throw new AppError(403, 'DISCOVERY_PRIVATE', 'This person is not accepting calls from unknown contacts.');
      }

      // Hard block
      if (connType === 'blocked') {
        throw new AppError(403, 'CALLER_BLOCKED', 'You cannot call this person.');
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
            const { getRedis } = await import('@privid/shared');
            const redis = getRedis();
            const rlKey = `call_unknown:${callerId}`;
            const count = await redis.incr(rlKey);
            if (count === 1) await redis.expire(rlKey, 600);
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
            const elapsed = Date.now() - new Date(recentCalls[0].created_at).getTime();
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

    if (calleeId === callerId) {
      throw new AppError(400, 'SELF_CALL', 'Cannot call yourself.');
    }

    const webrtcRoomId = crypto.randomBytes(16).toString('base64url');

    const [call] = await withTransaction(async (client) => {
      const { rows } = await client.query<CallRow>(
        `INSERT INTO calls (caller_id, callee_id, call_type, channel_id, webrtc_room_id)
         VALUES ($1, $2, $3, $4, $5)
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

      return rows;
    });

    // Track behavior event
    await trackEvent(callerId, 'call_initiated', calleeId, { call_id: call.call_id, call_type: callType });

    // ── Push notification to callee ───────────────────────────────────────────
    // Fire-and-forget — never block the call initiation response on this
    queryOne<{
      push_token: string | null;
      handle: string;
      display_name: string | null;
      trust_tier: string;
      trust_score: number;
      avatar_url: string | null;
    }>(
      `SELECT u.handle, u.display_name, u.trust_tier, u.trust_score, u.avatar_url,
              dr.push_token
       FROM users u
       LEFT JOIN device_registrations dr
         ON dr.user_id = u.user_id
       WHERE u.user_id = $1
       ORDER BY dr.last_seen_at DESC NULLS LAST
       LIMIT 1`,
      [callerId],
    ).then(async (caller) => {
      const tokenRow = await queryOne<{ push_token: string | null }>(
        `SELECT push_token FROM device_registrations
         WHERE user_id = $1 AND push_token IS NOT NULL
         ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`,
        [calleeId],
      );
      if (!tokenRow?.push_token || !caller) return;

      // Also get callee's connection type from callee's perspective
      const conn = await queryOne<{ connection_type: string }>(
        `SELECT connection_type FROM connections WHERE owner_id = $1 AND contact_id = $2`,
        [calleeId, callerId],
      );

      await sendIncomingCallPush(tokenRow.push_token, {
        callId:        call.call_id,
        fromUserId:    callerId,
        handle:        caller.handle,
        displayName:   caller.display_name ?? caller.handle,
        avatarUrl:     caller.avatar_url   ?? undefined,
        trustTier:     caller.trust_tier,
        trustScore:    caller.trust_score,
        connectionType: conn?.connection_type,
      });
    }).catch((err: Error) => {
      console.warn('[calls] FCM push failed (non-fatal):', err?.message);
    });

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
      `SELECT * FROM calls WHERE call_id = $1 AND callee_id = $2`,
      [req.params.id, req.user!.sub]
    );
    if (!call) throw new AppError(404, 'CALL_NOT_FOUND', 'Call not found.');
    if (call.status !== 'initiated' && call.status !== 'ringing') {
      throw new AppError(409, 'CALL_NOT_RINGING', 'Call is not in a ringing state.');
    }

    const [updated] = await query<CallRow>(
      `UPDATE calls SET status = 'answered', started_at = NOW() WHERE call_id = $1 RETURNING *`,
      [req.params.id]
    );

    res.json({ ok: true, data: { call_id: updated.call_id, status: updated.status, webrtc_room_id: updated.webrtc_room_id } });
  } catch (err) {
    next(err);
  }
});

// ─── POST /calls/:id/end ──────────────────────────────────────────────────────

callsRouter.post('/:id/end', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { reason } = z.object({ reason: z.enum(['declined', 'ended', 'failed']).default('ended') }).parse(req.body);

    const call = await queryOne<CallRow>(
      `SELECT * FROM calls WHERE call_id = $1 AND (caller_id = $2 OR callee_id = $2)`,
      [req.params.id, req.user!.sub]
    );
    if (!call) throw new AppError(404, 'CALL_NOT_FOUND', 'Call not found.');

    const durationSeconds = call.started_at
      ? Math.floor((Date.now() - new Date(call.started_at).getTime()) / 1000)
      : null;

    const finalStatus = call.status === 'answered' ? 'ended' : reason;

    const [updated] = await query<CallRow>(
      `UPDATE calls
       SET status = $1, ended_at = NOW(), duration_seconds = $2
       WHERE call_id = $3
       RETURNING *`,
      [finalStatus, durationSeconds, req.params.id]
    );

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

    const apiKey    = process.env.LIVEKIT_API_KEY    ?? 'devkey';
    const apiSecret = process.env.LIVEKIT_API_SECRET ?? 'devsecret';
    const livekitUrl = process.env.LIVEKIT_URL       ?? 'ws://localhost:7880';

    const user = await queryOne<{ handle: string; display_name: string }>(
      `SELECT handle, display_name FROM users WHERE user_id = $1`,
      [req.user!.sub],
    );

    const at = new AccessToken(apiKey, apiSecret, {
      identity: req.user!.sub,
      name: user?.display_name ?? user?.handle ?? req.user!.sub,
      ttl: '2h',
    });
    at.addGrant({
      roomJoin: true,
      room: call.webrtc_room_id,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const token = await at.toJwt();
    res.json({ ok: true, data: { token, url: livekitUrl } });
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

    const rows = await query(
      `SELECT
         c.call_id, c.call_type, c.status, c.started_at, c.ended_at, c.duration_seconds,
         c.caller_id, c.callee_id,
         caller.handle AS caller_handle, caller.display_name AS caller_name,
         caller.avatar_url AS caller_avatar_url,
         callee.handle AS callee_handle, callee.display_name AS callee_name,
         callee.avatar_url AS callee_avatar_url,
         CASE WHEN c.caller_id = $1 THEN 'outgoing' ELSE 'incoming' END AS direction
       FROM calls c
       JOIN users caller ON caller.user_id = c.caller_id
       JOIN users callee ON callee.user_id = c.callee_id
       WHERE c.caller_id = $1 OR c.callee_id = $1
       ORDER BY c.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user!.sub, limit, offset]
    );

    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// ─── GET /calls/:id ───────────────────────────────────────────────────────────

callsRouter.get('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const call = await queryOne(
      `SELECT
         c.*,
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
