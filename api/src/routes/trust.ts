import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '@trustroute/shared';
import type { IdentityRow } from '@trustroute/shared';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import {
  finalizeTrustFactor,
  getTrustScoreSnapshot,
  warmTrustScoreCache,
  ensureDeviceIntegrityFactor,
  recomputeAndPersist,
} from '../services/trustScore';
import type { VerificationFactorPoints } from '@trustroute/shared';
import {
  createDigilockerRequest,
  getDigilockerStatus,
  fetchAadhaar,
  DigilockerError,
} from '../services/digilocker';

export const trustRouter = Router();

function friendlyDigilocker(code: string): string {
  if (code === 'DIGILOCKER_NOT_CONFIGURED') {
    return 'Identity verification is briefly unavailable. Please try again soon.';
  }
  if (code === 'DIGILOCKER_TIMEOUT') {
    return 'DigiLocker is taking longer than usual. Please try again.';
  }
  return 'We couldn’t verify with DigiLocker. Please try again.';
}

function getNextTierInfo(
  score: number,
  factors: VerificationFactorPoints & { ml_modifier?: number },
): { next_tier: string | null; points_needed: number; actions: string[] } {
  if (score >= 80) return { next_tier: null, points_needed: 0, actions: [] };

  const thresholds = [
    { tier: 'premium', min: 80 },
    { tier: 'verified', min: 50 },
    { tier: 'basic', min: 30 },
  ];

  for (const threshold of thresholds) {
    if (score < threshold.min) {
      const gap = threshold.min - score;
      return {
        next_tier: threshold.tier,
        points_needed: gap,
        actions: suggestActions(factors),
      };
    }
  }
  return { next_tier: null, points_needed: 0, actions: [] };
}

function suggestActions(factors: VerificationFactorPoints & { ml_modifier?: number }): string[] {
  const suggestions: string[] = [];
  if (factors.govt_id_verified <= 0) suggestions.push('Verify your government ID via DigiLocker (+30 pts)');
  if (factors.device_integrity <= 0) suggestions.push('Complete device verification (+10 pts)');
  if (factors.liveness_check <= 0) suggestions.push('Complete the face check (+25 pts)');
  if (factors.profile_complete <= 0) suggestions.push('Add a profile photo and display name (+5 pts)');
  if (factors.phone_verified <= 0) suggestions.push('Optionally link a phone number (+15 pts)');
  if (suggestions.length === 0) {
    suggestions.push('Keep healthy call patterns and grow trusted connections');
  }
  return suggestions.slice(0, 3);
}

// ─── GET /trust/score ─────────────────────────────────────────────────────────

trustRouter.get('/score', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const healed = await ensureDeviceIntegrityFactor(userId).catch(() => false);
    if (healed) {
      await recomputeAndPersist(userId).catch(() => {});
    } else {
      warmTrustScoreCache(userId);
    }

    const [breakdown, history] = await Promise.all([
      getTrustScoreSnapshot(userId),
      query(
        `SELECT old_score, new_score, old_tier, new_tier, reason, created_at
           FROM trust_score_history
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 10`,
        [userId],
      ),
    ]);

    res.json({
      ok: true,
      data: {
        score: breakdown.total,
        tier: breakdown.tier,
        breakdown: breakdown.factors,
        history,
        next_tier_info: getNextTierInfo(breakdown.total, breakdown.factors),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /trust/verify/govt-id/initiate ──────────────────────────────────────

trustRouter.post('/verify/govt-id/initiate', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id_type } = z.object({
      id_type: z.enum(['aadhaar', 'pan']),
    }).parse(req.body);

    const already = await queryOne<{ status: string }>(
      `SELECT status FROM trust_factors
        WHERE user_id = $1 AND factor_type = 'govt_id_verified' AND is_latest = TRUE`,
      [req.user!.sub],
    );
    if (already?.status === 'completed') {
      throw new AppError(409, 'GOVT_ID_ALREADY_VERIFIED', 'Your government ID is already verified.');
    }

    const dg = await createDigilockerRequest();

    await query(
      `INSERT INTO trust_factors (user_id, factor_type, status, provider, provider_ref, score_delta, metadata)
       VALUES ($1, 'govt_id_verified', 'pending', 'setu', $2, 30, $3)
       ON CONFLICT (user_id, factor_type) WHERE is_latest = TRUE
       DO UPDATE SET
         provider_ref = EXCLUDED.provider_ref,
         status = 'pending',
         provider = 'setu',
         metadata = EXCLUDED.metadata,
         verified_at = NULL`,
      [req.user!.sub, dg.id, JSON.stringify({ id_type, dg_status: dg.status })],
    );

    res.json({ ok: true, data: { auth_url: dg.url, provider_ref: dg.id } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    if (err instanceof DigilockerError) return next(new AppError(err.httpStatus, err.code, friendlyDigilocker(err.code)));
    next(err);
  }
});

// ─── POST /trust/verify/govt-id/complete ─────────────────────────────────────

trustRouter.post('/verify/govt-id/complete', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { provider_ref } = z.object({ provider_ref: z.string().min(1) }).parse(req.body ?? {});

    const factor = await queryOne<{ factor_id: string; status: string }>(
      `SELECT factor_id, status
         FROM trust_factors
        WHERE user_id = $1
          AND factor_type = 'govt_id_verified'
          AND provider_ref = $2
          AND is_latest = TRUE`,
      [req.user!.sub, provider_ref],
    );
    if (!factor) throw new AppError(404, 'FACTOR_NOT_FOUND', 'Verification session not found.');

    if (factor.status === 'completed') {
      const snap = await getTrustScoreSnapshot(req.user!.sub);
      return res.json({ ok: true, data: { status: 'authenticated', score: snap.total, tier: snap.tier } });
    }

    const status = await getDigilockerStatus(provider_ref);
    if (status !== 'authenticated') {
      return res.json({ ok: true, data: { status, pending: true } });
    }

    const aadhaar = await fetchAadhaar(provider_ref);

    const identity = await queryOne<Pick<IdentityRow, 'identity_id' | 'status' | 'current_user_id'>>(
      `SELECT identity_id, status, current_user_id
         FROM identities
        WHERE doc_hash = $1`,
      [aadhaar.docHash],
    );
    if (identity?.status === 'banned' || identity?.status === 'ousted') {
      throw new AppError(403, 'ACCOUNT_BLOCKED', 'This identity cannot be reactivated. You can request a review.');
    }
    if (identity?.status === 'suspended') {
      throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This identity is suspended. You can request a review.');
    }
    if (identity?.current_user_id && identity.current_user_id !== req.user!.sub) {
      throw new AppError(409, 'IDENTITY_EXISTS', 'This identity already has a TrustRoute account. Use recovery instead.');
    }

    const clash = await queryOne<{ user_id: string }>(
      `SELECT user_id
         FROM users
        WHERE kyc_doc_hash = $1
          AND user_id <> $2
          AND account_status IN ('active','under_review','restricted','suspended')`,
      [aadhaar.docHash, req.user!.sub],
    );
    if (clash) {
      throw new AppError(409, 'IDENTITY_EXISTS', 'This identity already has a TrustRoute account. You can only hold one account.');
    }

    try {
      await withTransaction(async (client) => {
        const identityResult = await client.query<Pick<IdentityRow, 'identity_id'>>(
          `INSERT INTO identities
                 (legal_name, doc_type, doc_hash, provider, provider_ref, status, current_user_id, last_handle)
           SELECT $2, 'aadhaar', $3, 'setu', $4, 'active', $1, u.handle
             FROM users u
            WHERE u.user_id = $1
           ON CONFLICT (doc_hash) DO UPDATE
             SET legal_name = EXCLUDED.legal_name,
                 provider = EXCLUDED.provider,
                 provider_ref = EXCLUDED.provider_ref,
                 status = 'active',
                 status_reason = NULL,
                 current_user_id = EXCLUDED.current_user_id,
                 last_handle = EXCLUDED.last_handle,
                 deleted_at = NULL,
                 suspended_at = NULL,
                 updated_at = NOW()
           WHERE identities.status IN ('active','self_deleted')
             AND (identities.current_user_id IS NULL OR identities.current_user_id = $1)
           RETURNING identity_id`,
          [req.user!.sub, aadhaar.legalName, aadhaar.docHash, provider_ref],
        );
        const identityId = identityResult.rows[0]?.identity_id;
        if (!identityId) {
          throw new AppError(409, 'IDENTITY_EXISTS', 'This identity already has a TrustRoute account. Use recovery instead.');
        }

        await client.query(
          `UPDATE users
              SET identity_id = $2,
                  legal_name = $3,
                  kyc_status = 'verified',
                  kyc_provider = 'setu',
                  kyc_doc_hash = $4,
                  kyc_verified_at = NOW(),
                  updated_at = NOW()
            WHERE user_id = $1`,
          [req.user!.sub, identityId, aadhaar.legalName, aadhaar.docHash],
        );

        await client.query(
          `UPDATE trust_factors
              SET status = 'completed',
                  verified_at = NOW(),
                  metadata = metadata || $2::jsonb
            WHERE factor_id = $1`,
          [factor.factor_id, JSON.stringify({ verified_name: aadhaar.legalName, masked: aadhaar.maskedNumber ?? null })],
        );
      });
    } catch (dbErr) {
      if ((dbErr as { code?: string })?.code === '23505') {
        throw new AppError(409, 'IDENTITY_EXISTS', 'This identity already has a TrustRoute account. You can only hold one account.');
      }
      throw dbErr;
    }

    const breakdown = await finalizeTrustFactor(req.user!.sub, 'govt_id_verified');
    res.json({
      ok: true,
      data: { status: 'authenticated', legal_name: aadhaar.legalName, score: breakdown.total, tier: breakdown.tier },
    });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    if (err instanceof AppError) return next(err);
    if (err instanceof DigilockerError) return next(new AppError(err.httpStatus, err.code, friendlyDigilocker(err.code)));
    next(err);
  }
});

// ─── GET /trust/factors ───────────────────────────────────────────────────────

trustRouter.get('/factors', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const factors = await query(
      `SELECT factor_type, status, provider, score_delta, verified_at, expires_at, metadata
         FROM trust_factors
        WHERE user_id = $1
        ORDER BY created_at ASC`,
      [req.user!.sub],
    );
    res.json({ ok: true, data: factors });
  } catch (err) {
    next(err);
  }
});
