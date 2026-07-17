/**
 * Admin service: moderation actions on accounts, report/audit queues, appeals, and
 * business verification. Every state change writes an immutable admin-action record and
 * best-effort notifies the affected user.
 */
import { appError, buildPage, decodeCursor, type PageMeta } from '@trustroute/core';
import * as repo from './admin.repository';
import type { AdminActionRow, AccountStateChange } from './admin.repository';
import * as notifications from '../notifications/notifications.service';
import * as business from '../business/business.service';

export type ModerationAction = 'suspend' | 'ban' | 'restrict' | 'review' | 'restore';

const TRANSITIONS: Record<ModerationAction, AccountStateChange> = {
  suspend: { accountStatus: 'suspended', identityStatus: 'suspended', isActive: false, isUnderReview: false },
  ban: { accountStatus: 'banned', identityStatus: 'banned', isActive: false, isUnderReview: false },
  restrict: { accountStatus: 'restricted', isActive: true, isUnderReview: false },
  review: { accountStatus: 'under_review', isActive: true, isUnderReview: true },
  restore: { accountStatus: 'active', identityStatus: 'active', isActive: true, isUnderReview: false },
};

const USER_MESSAGE: Record<ModerationAction, { title: string; body: string }> = {
  suspend: { title: 'Account suspended', body: 'Your account has been suspended pending review.' },
  ban: { title: 'Account banned', body: 'Your account has been banned for violating our policies.' },
  restrict: { title: 'Account restricted', body: 'Some features have been limited on your account.' },
  review: { title: 'Account under review', body: 'Your account is under review.' },
  restore: { title: 'Account restored', body: 'Your account is active again. Welcome back!' },
};

export async function moderateUser(adminRef: string, userId: string, action: ModerationAction, reason?: string) {
  const change = { ...TRANSITIONS[action], reason: reason ?? null };
  if (!(await repo.applyAccountState(userId, change))) throw appError('NOT_FOUND', 'User not found.');
  await repo.logAction({ targetId: userId, action: `user.${action}`, adminRef, note: reason ?? null });
  await notifications.notifyUser(userId, USER_MESSAGE[action], { category: 'trust_security', data: { type: 'moderation', action } });
  return { userId, action, applied: true };
}

export async function getUser(userId: string) {
  const view = await repo.userView(userId);
  if (!view) throw appError('NOT_FOUND', 'User not found.');
  return view;
}

export async function reports(limit: number, cursor?: string): Promise<{ items: repo.ReportView[]; meta: PageMeta }> {
  const rows = await repo.listReports(limit, decodeCursor(cursor));
  return buildPage(rows, limit, (r) => ({ t: r.createdAt.toISOString(), id: r.reportId }));
}

function actionView(a: AdminActionRow) {
  return { actionId: a.actionId, targetId: a.targetId, action: a.action, adminRef: a.adminRef, note: a.note, createdAt: a.createdAt };
}

export async function actions(limit: number, cursor?: string): Promise<{ items: ReturnType<typeof actionView>[]; meta: PageMeta }> {
  const rows = await repo.listActions(limit, decodeCursor(cursor));
  const page = buildPage(rows, limit, (r) => ({ t: r.createdAt.toISOString(), id: r.actionId }));
  return { items: page.items.map(actionView), meta: page.meta };
}

export async function appeals(status?: string) {
  return { appeals: await repo.listAppeals(status) };
}

export async function resolveAppeal(
  adminRef: string,
  appealId: string,
  input: { status: 'in_review' | 'restored' | 'upheld' | 'rejected'; resolution?: string; reviewerMessage?: string },
) {
  if (!(await repo.resolveAppeal(appealId, { ...input, resolvedBy: adminRef }))) throw appError('NOT_FOUND', 'Appeal not found.');
  await repo.logAction({ action: `appeal.${input.status}`, adminRef, note: input.resolution ?? null, metadata: { appealId } });
  return { appealId, status: input.status };
}

// ── Business verification ─────────────────────────────────────────────────────

export async function pendingBusinesses() {
  return business.listByStatus('pending');
}

export async function verifyBusiness(adminRef: string, businessId: string) {
  const result = await business.verifyAndIssueKey(businessId);
  await repo.logAction({ action: 'business.verify', adminRef, note: result.business.name, metadata: { businessId } });
  return result; // includes the one-time apiKey
}

export async function rejectBusiness(adminRef: string, businessId: string, reason: string) {
  const result = await business.reject(businessId, reason);
  await repo.logAction({ action: 'business.reject', adminRef, note: reason, metadata: { businessId } });
  return result;
}
