/**
 * Calls service: initiate / answer / decline / end an in-app (Stream Video) call, plus
 * quality reports and history. Permission = the callee hasn't blocked the caller. A
 * ring-timeout job is enqueued on initiate so an unanswered call flips to `missed`.
 */
import crypto from 'crypto';
import {
  appError,
  config,
  logger,
  getStreamProvider,
  consumeRate,
  enqueue,
  buildPage,
  decodeCursor,
  type PageMeta,
} from '@trustroute/core';
import * as repo from './calls.repository';
import type { CallRow, CallWithCounterpart } from './calls.repository';
import * as usersRepo from '../users/users.repository';
import * as connectionsRepo from '../connections/connections.repository';

/** Seconds a call rings before the worker marks it missed. */
const RING_TIMEOUT_SECONDS = 45;
/** Max call initiations per minute per user. */
const CALL_RATE_MAX = 10;

function callView(c: CallRow) {
  return {
    callId: c.callId,
    callerId: c.callerId,
    calleeId: c.calleeId,
    callType: c.callType,
    status: c.status,
    streamCallId: c.streamCallId,
    startedAt: c.startedAt,
    endedAt: c.endedAt,
    durationSeconds: c.durationSeconds,
    declineReason: c.declineReason,
    createdAt: c.createdAt,
  };
}

function streamConfig(token: string, callId: string) {
  return {
    streamCallId: callId,
    videoToken: token,
    apiKey: config.STREAM_API_KEY ?? null,
    provider: getStreamProvider().configured ? 'stream' : 'mock',
  };
}

async function loadParticipant(callId: string, userId: string): Promise<CallRow> {
  const call = await repo.findForParticipant(callId, userId);
  if (!call) throw appError('CALL_NOT_FOUND');
  return call;
}

export async function initiate(
  callerId: string,
  input: { handle?: string; calleeId?: string; callType?: 'direct' | 'reachability'; channelId?: string },
) {
  // Resolve the callee (by @handle or explicit id).
  const callee = input.handle
    ? await usersRepo.findByHandle(input.handle)
    : input.calleeId
      ? await usersRepo.findById(input.calleeId)
      : null;
  if (!callee || callee.accountStatus !== 'active') throw appError('HANDLE_NOT_FOUND', 'That person is not reachable.');
  if (callee.userId === callerId) throw appError('BAD_REQUEST', 'You cannot call yourself.');

  // Permission: the callee must not have blocked the caller.
  if (await connectionsRepo.isBlockedBy(callerId, callee.userId)) throw appError('CALL_NOT_ALLOWED');

  await consumeRate(`call:${callerId}`, 60, CALL_RATE_MAX, 'CALL_RATE_LIMITED');

  const stream = getStreamProvider();
  const caller = await usersRepo.findById(callerId);
  await stream.upsertUser({ id: callerId, name: caller?.displayName ?? caller?.handle, image: caller?.avatarUrl ?? undefined });
  await stream.upsertUser({ id: callee.userId, name: callee.displayName ?? callee.handle, image: callee.avatarUrl ?? undefined });

  // The Stream room id is the call's own id: the app joins the room named by
  // the id it gets back, and answer/end address the same value. Minting a
  // second, separate uuid here meant the row pointed at a room nobody joined.
  const call = await repo.createCall({
    callerId,
    calleeId: callee.userId,
    callType: input.callType ?? 'direct',
    channelId: input.channelId ?? null,
  });
  const streamCallId = call.streamCallId ?? call.callId;

  // Backstop: if nobody answers, flip to missed. Best-effort — a queue outage must
  // never prevent a call from being placed (jobIds can't contain ':').
  try {
    await enqueue('ring-timeout', { call_id: call.callId }, { jobId: `ring-${call.callId}`, delayMs: RING_TIMEOUT_SECONDS * 1000 });
  } catch (err) {
    logger.warn('calls', 'failed to enqueue ring-timeout', { callId: call.callId, error: (err as Error).message });
  }
  await repo.logBehavior(callerId, 'call_initiated', callee.userId, { callId: call.callId, callType: call.callType });

  return { call: callView(call), stream: streamConfig(stream.videoToken(callerId), streamCallId) };
}

/** Stream Video credentials for the signed-in user. */
export async function streamToken(userId: string) {
  const stream = getStreamProvider();
  const u = await usersRepo.findById(userId);
  if (!u) throw appError('USER_INACTIVE');
  await stream.upsertUser({ id: userId, name: u.displayName ?? u.handle, image: u.avatarUrl ?? undefined });
  return {
    apiKey: config.STREAM_API_KEY ?? null,
    token: stream.videoToken(userId),
    provider: stream.configured ? 'stream' : 'mock',
    user: { id: userId, name: u.displayName ?? u.handle, image: u.avatarUrl },
  };
}

/**
 * Create the call row and hand back the id the app uses as the Stream room.
 * The app calls this before `getOrCreate(ringing: true)`; ringing itself is
 * driven by Stream, so this only needs to reserve and authorise the call.
 */
export async function prepareStream(
  callerId: string,
  input: { handle?: string; calleeId?: string; video?: boolean },
) {
  const { call } = await initiate(callerId, { handle: input.handle, calleeId: input.calleeId });
  return { callId: call.callId, video: Boolean(input.video), status: call.status };
}

export async function answer(userId: string, callId: string) {
  const call = await loadParticipant(callId, userId);
  if (call.calleeId !== userId) throw appError('FORBIDDEN', 'Only the callee can answer.');
  const updated = await repo.markAnswered(callId);
  if (!updated) throw appError('CALL_NOT_ALLOWED', 'This call can no longer be answered.');
  await repo.logBehavior(userId, 'call_answered', call.callerId, { callId });
  const stream = getStreamProvider();
  return { call: callView(updated), stream: streamConfig(stream.videoToken(userId), updated.streamCallId ?? callId) };
}

export async function decline(userId: string, callId: string, reason?: string) {
  const call = await loadParticipant(callId, userId);
  if (call.calleeId !== userId) throw appError('FORBIDDEN', 'Only the callee can decline.');
  const updated = await repo.markDeclined(callId, reason ?? null);
  if (!updated) throw appError('CALL_NOT_ALLOWED', 'This call can no longer be declined.');
  await repo.logBehavior(userId, 'call_declined', call.callerId, { callId, reason });
  return { call: callView(updated) };
}

export async function end(userId: string, callId: string) {
  await loadParticipant(callId, userId);
  const updated = await repo.markEnded(callId);
  if (!updated) {
    // Already terminal — return the current state idempotently.
    const current = await repo.findById(callId);
    return { call: callView(current!) };
  }
  await repo.logBehavior(userId, 'call_ended', null, { callId, durationSeconds: updated.durationSeconds });
  return { call: callView(updated) };
}

export async function submitQuality(
  userId: string,
  callId: string,
  metrics: { mosScore?: number; packetLossPct?: number; jitterMs?: number; rttMs?: number },
) {
  await loadParticipant(callId, userId);
  await repo.upsertQuality(callId, userId, metrics);
  return { recorded: true };
}

export async function history(
  userId: string,
  limit: number,
  cursor?: string,
): Promise<{ items: CallWithCounterpart[]; meta: PageMeta }> {
  const rows = await repo.listForUser(userId, limit, decodeCursor(cursor));
  return buildPage(rows, limit, (r) => ({ t: r.createdAt.toISOString(), id: r.callId }));
}

export async function get(userId: string, callId: string) {
  const call = await loadParticipant(callId, userId);
  return { call: callView(call) };
}
