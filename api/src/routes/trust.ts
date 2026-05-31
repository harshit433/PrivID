import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { query, queryOne, withTransaction, getRedis } from '@privid/shared';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { recomputeAndPersist, computeTrustScore } from '../services/trustScore';
import { isLivenessConfigured, checkLiveness, livenessThreshold } from '../services/liveness';
import { verifyAndroidIntegrityToken } from '../services/playIntegrity';
import { logger } from '../utils/logger';

export const trustRouter = Router();

// ─── GET /trust/nonce ─────────────────────────────────────────────────────────
// Generates a one-time nonce for Play Integrity token requests.
// The nonce is stored in Redis with a 5-minute TTL and consumed on device verify.

trustRouter.get('/nonce', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const nonce = crypto.randomBytes(32).toString('base64url'); // 43-char URL-safe base64
    const redis = getRedis();
    await redis.set(`integrity_nonce:${req.user!.sub}:${nonce}`, '1', 'EX', 300);
    res.json({ ok: true, data: { nonce } });
  } catch (err) {
    next(err);
  }
});

// ─── GET /trust/score ─────────────────────────────────────────────────────────
// Returns current score + full breakdown for the authenticated user

trustRouter.get('/score', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const breakdown = await computeTrustScore(req.user!.sub);
    const history = await query(
      `SELECT old_score, new_score, old_tier, new_tier, reason, created_at
       FROM trust_score_history
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [req.user!.sub]
    );

    res.json({
      ok: true,
      data: {
        score: breakdown.total,
        tier: breakdown.tier,
        breakdown: breakdown.factors,
        history,
        next_tier_info: getNextTierInfo(breakdown.total),
      },
    });
  } catch (err) {
    next(err);
  }
});

function getNextTierInfo(score: number): { next_tier: string | null; points_needed: number; actions: string[] } {
  if (score >= 80) return { next_tier: null, points_needed: 0, actions: [] };

  const thresholds = [
    { tier: 'premium', min: 80 },
    { tier: 'verified', min: 50 },
    { tier: 'basic', min: 30 },
  ];

  for (const t of thresholds) {
    if (score < t.min) {
      const gap = t.min - score;
      return {
        next_tier: t.tier,
        points_needed: gap,
        actions: suggestActions(score, gap),
      };
    }
  }
  return { next_tier: null, points_needed: 0, actions: [] };
}

function suggestActions(score: number, gap: number): string[] {
  const suggestions: string[] = [];
  if (score < 15) suggestions.push('Verify your phone number (+15 pts)');
  if (gap > 25)   suggestions.push('Complete liveness check (+25 pts)');
  if (gap > 30)   suggestions.push('Verify government ID (+30 pts)');
  if (gap > 10)   suggestions.push('Enable device integrity (+10 pts)');
  return suggestions.slice(0, 3);
}

// ─── POST /trust/verify/phone ─────────────────────────────────────────────────
// Marks phone as verified (called after OTP success — already handled in auth,
// but exposed here so mobile can call it explicitly post-login)

trustRouter.post('/verify/phone', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO trust_factors (user_id, factor_type, status, provider, score_delta, verified_at)
         VALUES ($1, 'phone_verified', 'completed', 'internal', 15, NOW())
         ON CONFLICT (user_id, factor_type) WHERE is_latest = TRUE
         DO UPDATE SET status = 'completed', verified_at = NOW()`,
        [req.user!.sub]
      );
    });

    const breakdown = await recomputeAndPersist(req.user!.sub);
    res.json({ ok: true, data: { score: breakdown.total, tier: breakdown.tier } });
  } catch (err) {
    next(err);
  }
});

// ─── POST /trust/verify/device ────────────────────────────────────────────────
// Validates Play Integrity (Android) or DeviceCheck (iOS) token

const deviceVerifySchema = z.object({
  platform: z.enum(['android', 'ios']),
  integrity_token: z.string().min(10),
  nonce: z.string().optional(),                  // the nonce we issued via GET /trust/nonce
  hardware_id: z.string().optional(),            // ANDROID_ID or iOS identifierForVendor
  device_fingerprint: z.string().optional(),     // sha256(hardware_id + phone_hash)
  push_token: z.string().optional(),
  device_pub_key: z.string().optional(),
  is_rooted: z.boolean().optional(),             // reported by native root-detection module
  is_emulator: z.boolean().optional(),
});

trustRouter.post('/verify/device', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = deviceVerifySchema.parse(req.body);

    // ── 1. Nonce validation ───────────────────────────────────────────────────
    if (body.nonce) {
      const redis = getRedis();
      const nonceKey = `integrity_nonce:${req.user!.sub}:${body.nonce}`;
      const valid = await redis.getdel(nonceKey); // consume once
      if (!valid) {
        throw new AppError(400, 'INVALID_NONCE', 'Integrity nonce is invalid or expired.');
      }
    }

    // ── 2. Root / emulator check ──────────────────────────────────────────────
    if (body.is_rooted === true && process.env.NODE_ENV === 'production') {
      throw new AppError(400, 'DEVICE_ROOTED', 'Rooted devices are not permitted.');
    }

    // ── 3. Play Integrity / DeviceCheck token verification ────────────────────
    const isVerified = process.env.NODE_ENV !== 'production'
      ? true
      : await verifyDeviceIntegrityToken(body.platform, body.integrity_token);

    if (!isVerified) {
      throw new AppError(400, 'DEVICE_INTEGRITY_FAILED', 'Device integrity check failed.');
    }

    // ── 4. SIM-binding / device fingerprint continuity ────────────────────────
    if (body.hardware_id && body.device_fingerprint) {
      // Check if this hardware ID is already bound to a DIFFERENT user
      const existing = await queryOne<{ user_id: string }>(
        `SELECT user_id FROM device_registrations
         WHERE hardware_id = $1 AND user_id != $2
         LIMIT 1`,
        [body.hardware_id, req.user!.sub]
      );
      if (existing) {
        // Hardware ID tied to another account — silently log, don't block
        // (legitimate when someone factory-resets and makes a new account)
        logger.warn('trust', `hardware_id ${body.hardware_id} was previously bound to user ${existing.user_id}`);
      }

      // If this user already has a registration with a DIFFERENT fingerprint, it
      // means the SIM changed (or app reinstall). Flag it but don't block for now.
      const ownReg = await queryOne<{ device_fingerprint: string | null }>(
        `SELECT device_fingerprint FROM device_registrations
         WHERE user_id = $1 AND hardware_id = $2
         LIMIT 1`,
        [req.user!.sub, body.hardware_id]
      );
      if (ownReg && ownReg.device_fingerprint && ownReg.device_fingerprint !== body.device_fingerprint) {
        logger.warn('trust', `SIM fingerprint changed for user ${req.user!.sub} — possible SIM swap`);
        // In production you'd set a flag and require re-verification
      }
    }

    await withTransaction(async (client) => {
      // Upsert device registration — store hardware + fingerprint
      await client.query(
        `INSERT INTO device_registrations
           (user_id, platform, integrity_token, push_token, device_pub_key, hardware_id, device_fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING`,
        [
          req.user!.sub,
          body.platform,
          body.integrity_token,
          body.push_token ?? null,
          body.device_pub_key ?? null,
          body.hardware_id ?? null,
          body.device_fingerprint ?? null,
        ]
      );

      // Update fingerprint if row already exists (hardware_id match)
      if (body.hardware_id) {
        await client.query(
          `UPDATE device_registrations
           SET integrity_token = $3, device_fingerprint = $4, last_seen_at = NOW()
           WHERE user_id = $1 AND hardware_id = $2`,
          [req.user!.sub, body.hardware_id, body.integrity_token, body.device_fingerprint ?? null]
        );
      }

      // Upsert trust factor
      await client.query(
        `INSERT INTO trust_factors (user_id, factor_type, status, provider, score_delta, verified_at)
         VALUES ($1, 'device_integrity', 'completed', $2, 10, NOW())
         ON CONFLICT (user_id, factor_type) WHERE is_latest = TRUE
         DO UPDATE SET status = 'completed', verified_at = NOW(), provider = EXCLUDED.provider`,
        [req.user!.sub, body.platform === 'android' ? 'play_integrity' : 'device_check']
      );
    });

    const breakdown = await recomputeAndPersist(req.user!.sub);
    res.json({ ok: true, data: { score: breakdown.total, tier: breakdown.tier } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// Validates Play Integrity (Android) or DeviceCheck (iOS) token server-side.
async function verifyDeviceIntegrityToken(platform: string, token: string): Promise<boolean> {
  if (platform === 'ios') {
    // DeviceCheck not wired yet — same as before.
    return true;
  }
  if (platform === 'android') {
    return verifyAndroidIntegrityToken(token);
  }
  return false;
}

// ─── POST /trust/verify/liveness/initiate ─────────────────────────────────────
// Creates a pending liveness factor and returns a provider_ref the client echoes
// back on /complete together with the captured selfie. No external session is
// needed — passive liveness is a single image check at /complete.

trustRouter.post('/verify/liveness/initiate', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const configured = isLivenessConfigured();
    const providerRef = crypto.randomUUID();

    await query(
      `INSERT INTO trust_factors (user_id, factor_type, status, provider, provider_ref, score_delta, metadata)
       VALUES ($1, 'liveness_check', 'pending', 'luxand', $2, 25, $3)
       ON CONFLICT (user_id, factor_type) WHERE is_latest = TRUE
       DO UPDATE SET
         provider_ref = EXCLUDED.provider_ref,
         status = 'pending',
         provider = 'luxand',
         metadata = EXCLUDED.metadata,
         verified_at = NULL`,
      [req.user!.sub, providerRef, JSON.stringify({ liveness_configured: configured })]
    );

    res.json({
      ok: true,
      data: {
        provider_ref: providerRef,
        liveness_enabled: configured,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /trust/verify/liveness/complete ─────────────────────────────────────
// Receives the captured selfie (base64), runs passive liveness via the managed
// provider and enforces the confidence threshold. On failure the factor is
// marked 'failed' and the client must not be allowed to proceed.

trustRouter.post('/verify/liveness/complete', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { provider_ref, image } = z
      .object({
        provider_ref: z.string().min(8),
        // data URL or raw base64 of the captured JPEG selfie
        image: z.string().min(100).optional(),
      })
      .parse(req.body);

    const factor = await queryOne<{ factor_id: string; status: string }>(
      `SELECT factor_id, status FROM trust_factors
       WHERE user_id = $1 AND factor_type = 'liveness_check' AND provider_ref = $2`,
      [req.user!.sub, provider_ref]
    );
    if (!factor) throw new AppError(404, 'FACTOR_NOT_FOUND', 'Liveness session not found.');
    if (factor.status === 'completed') {
      const breakdown = await computeTrustScore(req.user!.sub);
      return res.json({ ok: true, data: { score: breakdown.total, tier: breakdown.tier, already_verified: true } });
    }

    const configured = isLivenessConfigured();
    let passed: boolean;
    let score: number;

    if (configured) {
      if (!image) throw new AppError(400, 'IMAGE_REQUIRED', 'No selfie was provided for the liveness check.');
      const b64 = image.includes(',') ? image.slice(image.indexOf(',') + 1) : image;
      const buf = Buffer.from(b64, 'base64');
      if (buf.length < 1024) throw new AppError(400, 'IMAGE_INVALID', 'The captured selfie was empty. Please try again.');

      const result = await checkLiveness(buf).catch((err: Error) => {
        logger.error('liveness', 'Luxand check failed:', err.message);
        throw new AppError(
          502,
          'LIVENESS_CHECK_FAILED',
          'Liveness verification is temporarily unavailable. Please try again.',
        );
      });
      score = result.score;
      passed = result.real;
      logger.debug(
        'liveness',
        `complete ref=${provider_ref} score=${score} threshold=${livenessThreshold()} passed=${passed}`,
      );
    } else {
      // Dev bypass — no provider token configured.
      score = 1;
      passed = true;
    }

    if (!passed) {
      await query(
        `UPDATE trust_factors SET status = 'failed', metadata = metadata || $2::jsonb WHERE factor_id = $1`,
        [factor.factor_id, JSON.stringify({ score })]
      );
      throw new AppError(
        400,
        'LIVENESS_FAILED',
        'Liveness check did not pass. Use good lighting, look straight at the camera, and make sure it is a live person (not a photo or screen).'
      );
    }

    await query(
      `UPDATE trust_factors
       SET status = 'completed', verified_at = NOW(), metadata = metadata || $2::jsonb
       WHERE factor_id = $1`,
      [factor.factor_id, JSON.stringify({ score })]
    );

    const breakdown = await recomputeAndPersist(req.user!.sub);
    res.json({
      ok: true,
      data: {
        score: breakdown.total,
        tier: breakdown.tier,
        liveness: { score },
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /trust/verify/govt-id/initiate ──────────────────────────────────────
// Initiates Setu DigiLocker Aadhaar / PAN flow

trustRouter.post('/verify/govt-id/initiate', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id_type } = z.object({
      id_type: z.enum(['aadhaar', 'pan']),
    }).parse(req.body);

    // In production: call Setu DigiLocker API
    // const setuResp = await setuClient.createSession({ redirect_url: ... });
    const mockRef     = `setu_${id_type}_${Date.now()}`;
    const mockAuthUrl = `https://digilocker.gov.in/mock?ref=${mockRef}`;

    await query(
      `INSERT INTO trust_factors (user_id, factor_type, status, provider, provider_ref, score_delta, metadata)
       VALUES ($1, 'govt_id_verified', 'pending', 'setu', $2, 30, $3)
       ON CONFLICT (user_id, factor_type) WHERE is_latest = TRUE
       DO UPDATE SET provider_ref = EXCLUDED.provider_ref, status = 'pending', metadata = EXCLUDED.metadata`,
      [req.user!.sub, mockRef, JSON.stringify({ id_type })]
    );

    res.json({
      ok: true,
      data: {
        auth_url: mockAuthUrl,
        provider_ref: mockRef,
        ...(process.env.NODE_ENV !== 'production' && {
          _dev_note: 'Call POST /trust/verify/govt-id/complete to skip real DigiLocker',
        }),
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /trust/verify/govt-id/complete ─────────────────────────────────────

trustRouter.post('/verify/govt-id/complete', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { provider_ref } = z.object({ provider_ref: z.string() }).parse(req.body);

    const factor = await queryOne(
      `SELECT * FROM trust_factors WHERE user_id = $1 AND factor_type = 'govt_id_verified' AND provider_ref = $2`,
      [req.user!.sub, provider_ref]
    );
    if (!factor) throw new AppError(404, 'FACTOR_NOT_FOUND', 'Verification session not found.');
    if (factor.status === 'completed') throw new AppError(409, 'ALREADY_VERIFIED', 'Govt ID already verified.');

    await query(
      `UPDATE trust_factors SET status = 'completed', verified_at = NOW() WHERE factor_id = $1`,
      [factor.factor_id]
    );

    const breakdown = await recomputeAndPersist(req.user!.sub);
    res.json({ ok: true, data: { score: breakdown.total, tier: breakdown.tier } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
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
      [req.user!.sub]
    );
    res.json({ ok: true, data: factors });
  } catch (err) {
    next(err);
  }
});

// ─── GET /trust/:userId (public profile trust info) ───────────────────────────

trustRouter.get('/:userId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await queryOne(
      `SELECT user_id, handle, display_name, trust_tier, trust_score FROM users WHERE user_id = $1`,
      [req.params.userId]
    );
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');

    const factors = await query(
      `SELECT factor_type FROM trust_factors WHERE user_id = $1 AND status = 'completed'`,
      [req.params.userId]
    );

    res.json({
      ok: true,
      data: {
        user_id: user.user_id,
        handle: user.handle,
        display_name: user.display_name,
        trust_tier: user.trust_tier,
        trust_score: user.trust_score,
        verified_factors: factors.map((f) => f.factor_type),
      },
    });
  } catch (err) {
    next(err);
  }
});
