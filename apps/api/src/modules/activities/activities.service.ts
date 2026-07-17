/**
 * Activities service: start / join / sync / end a shared watch-together or screen-share
 * session. Scope is a direct pair or a group; only the controller may push sync state,
 * and only host/controller/creator may end. Media flows over Stream Video (mock token).
 */
import crypto from 'crypto';
import { appError, getStreamProvider, config } from '@trustroute/core';
import * as repo from './activities.repository';
import type { ActivityRow } from './activities.repository';
import * as usersRepo from '../users/users.repository';
import * as connectionsRepo from '../connections/connections.repository';
import * as groupsRepo from '../groups/groups.repository';

function view(a: ActivityRow) {
  return {
    activityId: a.activityId,
    scopeType: a.scopeType,
    adapter: a.adapter,
    status: a.status,
    streamCallId: a.streamCallId,
    hostUserId: a.hostUserId,
    controllerUserId: a.controllerUserId,
    presenterUserId: a.presenterUserId,
    lastState: a.lastState,
    stateRevision: a.stateRevision,
    createdAt: a.createdAt,
    endedAt: a.endedAt,
  };
}

function streamFor(userId: string, streamCallId: string) {
  const s = getStreamProvider();
  return { streamCallId, videoToken: s.videoToken(userId), apiKey: config.STREAM_API_KEY ?? null, provider: s.configured ? 'stream' : 'mock' };
}

/** Authorize the caller against the activity's scope (direct member or group member). */
async function authorizeScope(a: ActivityRow, userId: string): Promise<void> {
  if (a.scopeType === 'direct') {
    if (!repo.isDirectMember(a, userId)) throw appError('FORBIDDEN', 'You are not part of this activity.');
  } else if (a.groupId) {
    if (!(await groupsRepo.membership(a.groupId, userId))) throw appError('FORBIDDEN', 'You are not in this group.');
  }
}

export async function start(
  userId: string,
  input: { scope: 'direct' | 'group'; handle?: string; groupId?: string; adapter: 'youtube' | 'screen_share' },
) {
  const streamCallId = `activity-${crypto.randomUUID()}`;

  if (input.scope === 'direct') {
    if (!input.handle) throw appError('BAD_REQUEST', 'A handle is required for a direct activity.');
    const other = await usersRepo.findByHandle(input.handle);
    if (!other || other.accountStatus !== 'active') throw appError('HANDLE_NOT_FOUND');
    if (other.userId === userId) throw appError('BAD_REQUEST', 'You cannot start an activity with yourself.');
    if (await connectionsRepo.isBlockedBy(userId, other.userId)) throw appError('FORBIDDEN');
    const [low, high] = userId < other.userId ? [userId, other.userId] : [other.userId, userId];

    if (await repo.findActiveDirect(low, high)) throw appError('CONFLICT', 'An activity is already active with this person.');
    const session = await repo.create({ scopeType: 'direct', directMemberLow: low, directMemberHigh: high, adapter: input.adapter, streamCallId, hostUserId: userId });
    await repo.addParticipant(session.activityId, userId, 'host');
    return { ...view(session), stream: streamFor(userId, streamCallId) };
  }

  if (!input.groupId) throw appError('BAD_REQUEST', 'A groupId is required for a group activity.');
  if (!(await groupsRepo.membership(input.groupId, userId))) throw appError('FORBIDDEN', 'You are not in this group.');
  if (await repo.findActiveGroup(input.groupId)) throw appError('CONFLICT', 'An activity is already active in this group.');
  const session = await repo.create({ scopeType: 'group', groupId: input.groupId, adapter: input.adapter, streamCallId, hostUserId: userId });
  await repo.addParticipant(session.activityId, userId, 'host');
  return { ...view(session), stream: streamFor(userId, streamCallId) };
}

export async function get(userId: string, activityId: string) {
  const a = await repo.findById(activityId);
  if (!a) throw appError('NOT_FOUND', 'Activity not found.');
  await authorizeScope(a, userId);
  return { ...view(a), participants: await repo.listParticipants(activityId) };
}

export async function join(userId: string, activityId: string) {
  const a = await repo.findById(activityId);
  if (!a) throw appError('NOT_FOUND', 'Activity not found.');
  if (a.status !== 'active') throw appError('CONFLICT', 'This activity has ended.');
  await authorizeScope(a, userId);
  await repo.addParticipant(activityId, userId, 'participant');
  return { ...view(a), stream: streamFor(userId, a.streamCallId) };
}

export async function leave(userId: string, activityId: string) {
  const a = await repo.findById(activityId);
  if (!a) throw appError('NOT_FOUND', 'Activity not found.');
  await repo.markLeft(activityId, userId);
  // Host leaving ends the session for everyone.
  if (a.hostUserId === userId && a.status === 'active') {
    await repo.end(activityId);
    return { left: true, ended: true };
  }
  return { left: true, ended: false };
}

export async function updateState(userId: string, activityId: string, state: Record<string, unknown>, baseRevision: number) {
  const a = await repo.findById(activityId);
  if (!a) throw appError('NOT_FOUND', 'Activity not found.');
  if (a.status !== 'active') throw appError('CONFLICT', 'This activity has ended.');
  if (a.controllerUserId !== userId) throw appError('FORBIDDEN', 'Only the controller can drive playback.');
  const updated = await repo.updateState(activityId, state, baseRevision);
  if (!updated) throw appError('CONFLICT', 'State is out of date — refetch and retry.');
  return { stateRevision: updated.stateRevision, lastState: updated.lastState };
}

export async function setPresenter(userId: string, activityId: string, presenterUserId: string | null) {
  const a = await repo.findById(activityId);
  if (!a) throw appError('NOT_FOUND', 'Activity not found.');
  if (a.hostUserId !== userId && a.controllerUserId !== userId) throw appError('FORBIDDEN');
  await repo.setPresenter(activityId, presenterUserId);
  return { presenterUserId };
}

export async function end(userId: string, activityId: string) {
  const a = await repo.findById(activityId);
  if (!a) throw appError('NOT_FOUND', 'Activity not found.');
  if (![a.hostUserId, a.controllerUserId, a.createdBy].includes(userId)) {
    throw appError('FORBIDDEN', 'Only the host can end this activity.');
  }
  const ended = await repo.end(activityId);
  return { ...view(ended ?? a) };
}
