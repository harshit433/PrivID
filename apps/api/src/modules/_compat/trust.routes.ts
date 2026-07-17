/**
 * Legacy `/trust/*` compatibility. v2 has no standalone trust module — the score lives on
 * the user (worker-computed) and factors in `trust_factors`. These read routes surface
 * both. Re-verification (`/verify/govt-id/*`) runs through the onboarding recovery flow in
 * v2, so it is not re-exposed here; the app should route re-verification to onboarding.
 */
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, requireAuth, apiLimiter, appError, db, users, trustFactors, eq, and } from '@trustroute/core';

const router = Router();
router.use(requireAuth);
const uid = (req: { user?: { sub: string } }) => req.user!.sub;

router.get('/score', asyncHandler(async (req, res) => {
  const [u] = await db.select({ trustScore: users.trustScore, trustTier: users.trustTier, isUnderReview: users.isUnderReview }).from(users).where(eq(users.userId, uid(req))).limit(1);
  if (!u) throw appError('NOT_FOUND', 'User not found.');
  sendOk(res, { score: u.trustScore, tier: u.trustTier, isUnderReview: u.isUnderReview });
}));

router.get('/factors', asyncHandler(async (req, res) => {
  const factors = await db
    .select({ factorType: trustFactors.factorType, status: trustFactors.status, scoreDelta: trustFactors.scoreDelta, provider: trustFactors.provider, verifiedAt: trustFactors.verifiedAt, expiresAt: trustFactors.expiresAt })
    .from(trustFactors)
    .where(and(eq(trustFactors.userId, uid(req)), eq(trustFactors.isLatest, true)));
  sendOk(res, { factors });
}));

// Re-verification is an onboarding (recovery) concern in v2.
const reverifyMoved = asyncHandler(async () => {
  throw appError('NOT_CONFIGURED', 'Re-verification runs through onboarding recovery in v2. Start /onboarding with purpose "recovery".');
});
router.post('/verify/govt-id/initiate', reverifyMoved);
router.post('/verify/govt-id/complete', reverifyMoved);

export function register(app: Express): void {
  app.use('/trust', apiLimiter, router);
}
