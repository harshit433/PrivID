/**
 * Legacy `/me/*` compatibility routes. The mobile app (built against the old backend)
 * groups all self-account operations under `/me`; v2 splits them across `/users`,
 * `/connections`, and settings. These thin routes re-expose the legacy surface and
 * delegate to the v2 services, so the app works against v2 with only a base-URL change.
 * Retire this file once the mobile client migrates to native v2 paths.
 */
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, requireAuth, apiLimiter, appError, db, users, trustFactors, connections, eq, and, sql } from '@trustroute/core';
import * as usersSvc from '../users/users.service';
import * as connectionsSvc from '../connections/connections.service';

const router = Router();
router.use(requireAuth);

const uid = (req: { user?: { sub: string } }) => req.user!.sub;

// ── Profile ─────────────────────────────────────────────────────────────────
router.get('/', asyncHandler(async (req, res) => sendOk(res, await usersSvc.getMe(uid(req)))));
router.get('/summary', asyncHandler(async (req, res) => sendOk(res, await usersSvc.getMe(uid(req)))));
router.patch('/', asyncHandler(async (req, res) => sendOk(res, await usersSvc.updateProfile(uid(req), req.body as Record<string, unknown>))));

// ── Trust (read) ──────────────────────────────────────────────────────────────
async function trustView(userId: string) {
  const [u] = await db.select({ trustScore: users.trustScore, trustTier: users.trustTier, isUnderReview: users.isUnderReview }).from(users).where(eq(users.userId, userId)).limit(1);
  if (!u) throw appError('NOT_FOUND', 'User not found.');
  const factors = await db
    .select({ factorType: trustFactors.factorType, status: trustFactors.status, scoreDelta: trustFactors.scoreDelta, verifiedAt: trustFactors.verifiedAt })
    .from(trustFactors)
    .where(and(eq(trustFactors.userId, userId), eq(trustFactors.isLatest, true)));
  return { score: u.trustScore, tier: u.trustTier, isUnderReview: u.isUnderReview, factors };
}
router.get('/trust', asyncHandler(async (req, res) => sendOk(res, await trustView(uid(req)))));

// ── Settings groups (discovery / notifications / consents live in one settings blob) ─
router.get('/discovery', asyncHandler(async (req, res) => sendOk(res, await usersSvc.getSettings(uid(req)))));
router.patch('/discovery', asyncHandler(async (req, res) => sendOk(res, await usersSvc.updateSettings(uid(req), req.body as Record<string, unknown>))));
router.get('/notifications', asyncHandler(async (req, res) => sendOk(res, await usersSvc.getSettings(uid(req)))));
router.patch('/notifications', asyncHandler(async (req, res) => sendOk(res, await usersSvc.updateSettings(uid(req), req.body as Record<string, unknown>))));
router.get('/consents', asyncHandler(async (req, res) => sendOk(res, await usersSvc.getSettings(uid(req)))));
router.patch('/consents', asyncHandler(async (req, res) => sendOk(res, await usersSvc.updateSettings(uid(req), req.body as Record<string, unknown>))));

// ── Data export ─────────────────────────────────────────────────────────────
router.post('/export', asyncHandler(async (req, res) => sendOk(res, await usersSvc.requestDataExport(uid(req)), { status: 202 })));

// ── Blocked contacts ───────────────────────────────────────────────────────
router.get('/blocked', asyncHandler(async (req, res) => {
  const rows = await db
    .select({ contactId: connections.contactId, contactName: connections.contactName, handle: users.handle, displayName: users.displayName, updatedAt: connections.updatedAt })
    .from(connections)
    .innerJoin(users, eq(users.userId, connections.contactId))
    .where(and(eq(connections.ownerId, uid(req)), eq(connections.connectionType, 'blocked')))
    .orderBy(sql`${connections.updatedAt} DESC`);
  sendOk(res, { blocked: rows });
}));
router.delete('/blocked/:userId', asyncHandler(async (req, res) => sendOk(res, await connectionsSvc.unblock(uid(req), req.params.userId!))));

// ── Handle ────────────────────────────────────────────────────────────────
router.patch('/handle', asyncHandler(async (req, res) => {
  const { handle } = req.body as { handle: string };
  sendOk(res, await usersSvc.changeHandle(uid(req), handle));
}));
router.get('/handle/status', asyncHandler(async (req, res) => {
  const me = await usersSvc.getMe(uid(req));
  sendOk(res, { handle: me.handle, handleChangedAt: me.handleChangedAt });
}));
router.get('/handle/check', asyncHandler(async (req, res) => {
  const handle = String(req.query.handle ?? '').toLowerCase().trim();
  if (handle.length < 3) return sendOk(res, { available: false, reason: 'too_short' });
  const [taken] = await db.select({ id: users.userId }).from(users).where(eq(users.handle, handle)).limit(1);
  sendOk(res, { available: !taken, handle });
}));

// ── Phone (optional reachability factor; no verify flow in v2) ───────────────
const phoneMoved = asyncHandler(async () => {
  throw appError('NOT_CONFIGURED', 'Phone verification is not a v2 flow. Phone is an optional reachability attribute set during onboarding.');
});
router.post('/phone', phoneMoved);
router.delete('/phone', phoneMoved);

// ── Account deletion ──────────────────────────────────────────────────────
router.get('/delete-preview', asyncHandler(async (_req, res) =>
  sendOk(res, { willDelete: ['profile', 'connections', 'call history', 'wallet balance', 'chats'], identityReleased: true, reversible: false }),
));
router.delete('/', asyncHandler(async (req, res) => sendOk(res, await usersSvc.deleteAccount(uid(req)))));

export function register(app: Express): void {
  app.use('/me', apiLimiter, router);
}
