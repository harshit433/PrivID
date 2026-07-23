/**
 * Account appeals.
 *
 * Enforcement in TrustRoute is identity-level and effectively permanent, so the
 * appeal path has to work for someone who cannot sign in. These endpoints are
 * therefore unauthenticated: the subject is resolved from the onboarding
 * session the blocked screen already holds, falling back to an explicitly
 * supplied identity/user id.
 *
 * Because they are public, they deliberately reveal nothing about whether an
 * identity exists — an unknown subject yields the same empty answer as one with
 * no appeal on file.
 */
import { appError, logger } from '@trustroute/core';
import * as repo from './appeals.repository';
import type { AppealRow } from './appeals.repository';
import * as onboardingRepo from './onboarding.repository';

const MAX_REASON = 2000;
const MAX_EVIDENCE = 4000;

export interface AppealSubject {
  userId: string | null;
  identityId: string | null;
}

function view(row: AppealRow) {
  return {
    appealId: row.appealId,
    status: row.status,
    reason: row.reason,
    evidence: row.evidence,
    reviewerMessage: row.reviewerMessage,
    resolution: row.resolution,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Work out who is appealing. A session id is the trustworthy path — it was
 * minted by us and already carries the matched identity. The explicit ids are
 * accepted because the blocked screen may only have those, but they are never
 * echoed back, so passing a guessed id reveals nothing.
 */
async function resolveSubject(input: {
  sessionId?: string;
  identityId?: string;
  userId?: string;
}): Promise<AppealSubject> {
  if (input.sessionId) {
    const session = await onboardingRepo.findById(input.sessionId);
    if (session && (session.identityId || session.matchedUserId)) {
      return { identityId: session.identityId, userId: session.matchedUserId };
    }
  }
  return { identityId: input.identityId ?? null, userId: input.userId ?? null };
}

export async function submit(input: {
  sessionId?: string;
  identityId?: string;
  userId?: string;
  reason: string;
  evidence?: string;
}) {
  const subject = await resolveSubject(input);
  if (!subject.identityId && !subject.userId) {
    throw appError('BAD_REQUEST', 'We could not identify the account to appeal for.');
  }

  const reason = input.reason.trim();
  if (reason.length < 20) {
    throw appError('BAD_REQUEST', 'Please describe what happened in at least 20 characters.');
  }

  // One open appeal at a time: a queue of duplicates helps nobody and is an
  // easy way to flood review. Return the existing one instead of erroring, so
  // the client can just show its status.
  const open = await repo.findOpen(subject);
  if (open) return { appeal: view(open), duplicate: true };

  const created = await repo.create({
    userId: subject.userId,
    identityId: subject.identityId,
    reason: reason.slice(0, MAX_REASON),
    evidence: input.evidence?.trim().slice(0, MAX_EVIDENCE) || null,
  });

  logger.info('appeals', 'appeal submitted', {
    appealId: created.appealId,
    identityId: subject.identityId,
    userId: subject.userId,
  });

  return { appeal: view(created), duplicate: false };
}

export async function status(input: {
  sessionId?: string;
  identityId?: string;
  userId?: string;
}) {
  const subject = await resolveSubject(input);
  if (!subject.identityId && !subject.userId) return { appeal: null };
  const latest = await repo.latestFor(subject);
  return { appeal: latest ? view(latest) : null };
}
