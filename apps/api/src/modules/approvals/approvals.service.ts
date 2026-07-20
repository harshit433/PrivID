/**
 * Approvals service. Creates approval requests, lists them (expiring overdue ones
 * first), and records a user's approve/deny decision. A request that's already
 * resolved or expired can't be responded to.
 */
import { appError } from '@trustroute/core';
import * as repo from './approvals.repository';

const DEFAULT_TTL_SECONDS = 120;

function view(row: repo.ApprovalRow) {
  return {
    requestId: row.requestId,
    relyingParty: row.relyingParty,
    action: row.action,
    status: row.status,
    context: row.context,
    expiresAt: row.expiresAt,
    respondedAt: row.respondedAt,
    createdAt: row.createdAt,
  };
}

export async function createRequest(
  userId: string,
  input: {
    relyingParty: string;
    action: string;
    expiresInSeconds?: number;
    context?: Record<string, string>;
  },
) {
  const ttl = input.expiresInSeconds ?? DEFAULT_TTL_SECONDS;
  const row = await repo.create({
    userId,
    relyingParty: input.relyingParty,
    action: input.action,
    expiresAt: new Date(Date.now() + ttl * 1000),
    context: input.context ?? {},
  });
  return view(row);
}

export async function listRequests(
  userId: string,
  status?: 'pending' | 'approved' | 'denied' | 'expired',
) {
  await repo.expireOverdue(userId);
  const rows = await repo.listForUser(userId, status);
  return rows.map(view);
}

export async function getRequest(userId: string, requestId: string) {
  await repo.expireOverdue(userId);
  const row = await repo.getOwned(userId, requestId);
  if (!row) {
    throw appError('NOT_FOUND', 'Approval request not found.');
  }
  return view(row);
}

export async function respond(
  userId: string,
  requestId: string,
  decision: 'approve' | 'deny',
) {
  await repo.expireOverdue(userId);
  const existing = await repo.getOwned(userId, requestId);
  if (!existing) {
    throw appError('NOT_FOUND', 'Approval request not found.');
  }
  if (existing.status !== 'pending') {
    throw appError(
      'CONFLICT',
      existing.status === 'expired'
        ? 'This request has expired.'
        : 'This request was already answered.',
    );
  }
  const row = await repo.respondIfPending(
    userId,
    requestId,
    decision === 'approve' ? 'approved' : 'denied',
  );
  if (!row) {
    // Lost a race — someone/expiry resolved it between our read and write.
    throw appError('CONFLICT', 'This request was already answered.');
  }
  return view(row);
}
