/**
 * Shared TrustRoute policy gates for 1:1 direct / reachability calls.
 * Used by Stream Video prepare and legacy direct-call initiate.
 */
import { z } from 'zod';
import { query, queryOne, withTransaction, getRedis } from '@trustroute/shared';
import type { CallRow, ConnectionRow, ReachabilityChannelRow } from '@trustroute/shared';
import { AppError } from '../middleware/errorHandler';

export const STREAM_CALL_ROOM_MARKER = 'stream';

export function isStreamBackedCall(webrtcRoomId: string | null | undefined): boolean {
  return webrtcRoomId === STREAM_CALL_ROOM_MARKER;
}

export const initiateSchema = z.object({
  callee_id: z.string().uuid().optional(),
  channel_token: z.string().optional(),
  video: z.boolean().optional(),
}).refine((d) => d.callee_id || d.channel_token, {
  message: 'Either callee_id or channel_token is required.',
});

export const streamPrepareSchema = initiateSchema;

export function dynamicCooldownMs(calls: Array<{ status: string }>): number {
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

export interface ResolvedDirectCall {
  calleeId: string;
  channelId: string | null;
  callType: 'direct' | 'reachability';
}

/** Resolve callee + run all permission / rate-limit gates. */
export async function resolveDirectCallTarget(
  callerId: string,
  body: z.infer<typeof initiateSchema>,
): Promise<ResolvedDirectCall> {
  let calleeId: string;
  let channelId: string | null = null;
  let callType: 'direct' | 'reachability' = 'direct';

  if (body.channel_token) {
    const channel = await queryOne<ReachabilityChannelRow>(
      `SELECT * FROM reachability_channels WHERE token = $1 AND status = 'active'`,
      [body.channel_token],
    );
    if (!channel) throw new AppError(404, 'CHANNEL_NOT_FOUND', 'Reachability link not found or inactive.');
    if (channel.expires_at && new Date() > channel.expires_at) {
      throw new AppError(410, 'CHANNEL_EXPIRED', 'This reachability link has expired.');
    }

    const today = new Date().toISOString().slice(0, 10);
    const [{ count }] = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM channel_usage_log
       WHERE channel_id = $1 AND action = 'call_attempted' AND created_at::date = $2::date`,
      [channel.channel_id, today],
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

    if (calleeUser?.discovery_mode === 'private' && connType === 'unknown') {
      throw new AppError(403, 'DISCOVERY_PRIVATE', 'This person is not accepting calls from unknown contacts.');
    }

    if (connType === 'blocked') {
      throw new AppError(403, 'CALLER_BLOCKED', 'You cannot call this person.');
    }

    if (callerToCalleeConn?.connection_type === 'blocked') {
      throw new AppError(403, 'CALL_BLOCKED', 'You cannot call someone you have blocked.');
    }

    if (connType === 'temporary' && calleeConn?.temporary_expires_at) {
      if (new Date() > new Date(calleeConn.temporary_expires_at)) {
        throw new AppError(403, 'TEMPORARY_EXPIRED', 'Your temporary access to this person has expired.');
      }
    }

    if (connType === 'temporary' || connType === 'unknown') {
      const dailyLimit = connType === 'temporary'
        ? (calleeConn?.daily_call_limit ?? 5)
        : 4;

      const [countRow] = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM calls
         WHERE caller_id = $1 AND callee_id = $2
           AND created_at >= CURRENT_DATE`,
        [callerId, calleeId],
      );
      if (parseInt(countRow.count, 10) >= dailyLimit) {
        throw new AppError(429, 'DAILY_LIMIT_REACHED', 'Daily call limit reached for this contact. Try again tomorrow.');
      }

      if (connType === 'unknown') {
        try {
          const redis = getRedis();
          const rlKey = `call_unknown:${callerId}`;
          const pipeline = redis.pipeline();
          pipeline.incr(rlKey);
          pipeline.expire(rlKey, 600, 'NX');
          const results = await pipeline.exec();
          const count = (results?.[0]?.[1] as number) ?? 0;
          if (count > 30) {
            throw new AppError(429, 'CALL_RATE_LIMITED',
              'Too many calls to new contacts. Please wait a few minutes.');
          }
        } catch (e) {
          if (e instanceof AppError) throw e;
        }

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

  return { calleeId, channelId, callType };
}

export async function createOrReuseDirectCall(
  callerId: string,
  calleeId: string,
  channelId: string | null,
  callType: 'direct' | 'reachability',
  webrtcRoomId: string,
): Promise<{ call: CallRow; reused: boolean }> {
  return withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`call_init_${callerId}`]);

    const ACTIVE = `('initiated','ringing','answered')`;

    const existing = await client.query<CallRow>(
      `SELECT * FROM calls
        WHERE caller_id = $1 AND callee_id = $2 AND status IN ${ACTIVE}
        ORDER BY created_at DESC LIMIT 1`,
      [callerId, calleeId],
    );
    if ((existing.rowCount ?? 0) > 0) {
      return { call: existing.rows[0], reused: true };
    }

    const activeCallee = await client.query(
      `SELECT 1 FROM calls
        WHERE callee_id = $1 AND caller_id <> $2 AND status IN ${ACTIVE} LIMIT 1`,
      [calleeId, callerId],
    );
    if ((activeCallee.rowCount ?? 0) > 0) {
      throw new AppError(409, 'CALLEE_BUSY', 'The person you are calling is already on a call.');
    }

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
      [callerId, calleeId, callType, channelId, webrtcRoomId],
    );

    if (channelId) {
      await client.query(
        `INSERT INTO channel_usage_log (channel_id, caller_id, action) VALUES ($1, $2, 'call_attempted')`,
        [channelId, callerId],
      );
      await client.query(
        `UPDATE reachability_channels SET use_count = use_count + 1 WHERE channel_id = $1`,
        [channelId],
      );
    }

    return { call: rows[0], reused: false };
  });
}
