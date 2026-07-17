/**
 * Reports service: file a trust-weighted report against a user (by @handle) or a phone
 * number. The reporter's own trust raises the signal weight; `blockAlso` additionally
 * blocks the target. Duplicate reports within 24h are collapsed.
 */
import { appError } from '@trustroute/core';
import * as repo from './reports.repository';
import type { ReportRow } from './reports.repository';
import * as usersRepo from '../users/users.repository';
import * as connectionsRepo from '../connections/connections.repository';

/** Weight a report by the reporter's trust: 1.00 (new) … 2.00 (fully trusted). */
function signalWeight(reporterTrustScore: number): string {
  const w = Math.min(2, Math.max(1, 1 + reporterTrustScore / 100));
  return w.toFixed(2);
}

function view(r: ReportRow) {
  return {
    reportId: r.reportId,
    reportedUserId: r.reportedUserId,
    reportedNumberE164: r.reportedNumberE164,
    reasonType: r.reasonType,
    contextType: r.contextType,
    signalWeight: r.signalWeight,
    blockAlso: r.blockAlso,
    createdAt: r.createdAt,
  };
}

export async function file(
  reporterId: string,
  input: {
    handle?: string;
    reportedNumber?: string;
    reasonType: ReportRow['reasonType'];
    note?: string;
    contextType?: ReportRow['contextType'];
    contextId?: string;
    blockAlso?: boolean;
  },
) {
  const reporter = await usersRepo.findById(reporterId);
  if (!reporter) throw appError('USER_INACTIVE');

  let reportedUserId: string | null = null;
  if (input.handle) {
    const target = await usersRepo.findByHandle(input.handle);
    if (!target) throw appError('HANDLE_NOT_FOUND');
    if (target.userId === reporterId) throw appError('BAD_REQUEST', 'You cannot report yourself.');
    reportedUserId = target.userId;
    if (await repo.recentDuplicate(reporterId, reportedUserId)) {
      throw appError('CONFLICT', 'You have already reported this user recently.');
    }
  } else if (!input.reportedNumber) {
    throw appError('BAD_REQUEST', 'Provide a handle or a phone number to report.');
  }

  const report = await repo.create({
    reporterId,
    reportedUserId,
    reportedNumberE164: input.reportedNumber ?? null,
    reasonType: input.reasonType,
    note: input.note ?? null,
    contextType: input.contextType ?? null,
    contextId: input.contextId ?? null,
    signalWeight: signalWeight(reporter.trustScore),
    blockAlso: Boolean(input.blockAlso),
  });

  // Optionally block the reported user in the same action.
  if (input.blockAlso && reportedUserId) {
    await connectionsRepo.upsert(reporterId, reportedUserId, {});
    await connectionsRepo.setType(reporterId, reportedUserId, 'blocked');
  }

  return view(report);
}

export async function mine(reporterId: string) {
  return { reports: (await repo.listByReporter(reporterId)).map(view) };
}
