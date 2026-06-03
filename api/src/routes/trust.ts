import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { query, queryOne, withTransaction, getRedis, keys } from '@trustroute/shared';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { recomputeAndPersist, computeTrustScore } from '../services/trustScore';
import { isLivenessConfigured, checkLiveness, livenessThreshold } from '../services/liveness';
import { verifyAndroidIntegrityToken } from '../services/playIntegrity';
import { logger } from '../utils/logger';
import { verifyMsg91AccessToken } from '../services/msg91';
import { phonesMatch } from '../utils/phoneMatch';

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

// ─── POST /trust/verify/device/root ───────────────────────────────────────────
// Step 1 — rooted / tampered device check (definitive indicators only).

const rootCheckSchema = z.object({
  indicators: z.array(z.string()).default([]),
  is_emulator: z.boolean().default(false),
});

trustRouter.post('/verify/device/root', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = rootCheckSchema.parse(req.body);
    const definitive = body.indicators.filter((i) => !i.endsWith('_info'));

    if (process.env.NODE_ENV === 'production') {
      if (body.is_emulator) {
        throw new AppError(400, 'DEVICE_EMULATOR', 'Emulators are not permitted for verification.');
      }
      if (definitive.length > 0) {
        throw new AppError(
          400,
          'DEVICE_ROOTED',
          'This device appears rooted or tampered. PrivID requires a standard, unmodified device.',
        );
      }
    }

    res.json({ ok: true, data: { passed: true, indicators: body.indicators } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /trust/verify/device/integrity ───────────────────────────────────────
// Step 2 — Google Play Integrity (Android) or DeviceCheck (iOS).

const integrityVerifySchema = z.object({
  platform: z.enum(['android', 'ios']),
  integrity_token: z.string().min(10),
  nonce: z.string().min(10),
});

trustRouter.post('/verify/device/integrity', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = integrityVerifySchema.parse(req.body);

    const redis = getRedis();
    const nonceKey = `integrity_nonce:${req.user!.sub}:${body.nonce}`;
    const valid = await redis.getdel(nonceKey);
    if (!valid) {
      throw new AppError(400, 'INVALID_NONCE', 'Integrity nonce is invalid or expired. Please retry.');
    }

    const isVerified =
      process.env.NODE_ENV !== 'production'
        ? true
        : await verifyDeviceIntegrityToken(body.platform, body.integrity_token);

    if (!isVerified) {
      throw new AppError(
        400,
        'DEVICE_INTEGRITY_FAILED',
        'Google Play Integrity could not verify this install. Install from Google Play or a registered test build.',
      );
    }

    res.json({ ok: true, data: { verified: true } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── GET /trust/verify/device/network ─────────────────────────────────────────
// Step 3 — authenticated HTTPS round-trip (TLS terminates before this handler).

trustRouter.get('/verify/device/network', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const secure =
      req.secure ||
      req.headers['x-forwarded-proto'] === 'https' ||
      process.env.NODE_ENV !== 'production';

    if (!secure && process.env.NODE_ENV === 'production') {
      throw new AppError(400, 'INSECURE_CONNECTION', 'Connection must use HTTPS.');
    }

    res.json({
      ok: true,
      data: {
        secure_connection: secure,
        authenticated: true,
        server_time: new Date().toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

const SIM_SMS_TTL_SEC = 120;

// ─── POST /trust/verify/device/sim-sms/initiate ───────────────────────────────
// Step 4a — Open SIM binding session. SMS is sent by the MSG91 widget on the device.

const simSmsInitiateSchema = z.object({
  hardware_id: z.string().min(1),
  device_fingerprint: z.string().optional(),
});

trustRouter.post('/verify/device/sim-sms/initiate', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = simSmsInitiateSchema.parse(req.body);
    const userId = req.user!.sub;
    const redis = getRedis();

    const user = await queryOne<{ phone_e164: string }>(
      `SELECT phone_e164 FROM users WHERE user_id = $1`,
      [userId],
    );
    if (!user?.phone_e164) {
      throw new AppError(400, 'PHONE_NOT_FOUND', 'Verified phone number not found on your account.');
    }

    const rateLimitKey = keys.rateLimitSimSms(userId);
    const priorAttempts = await redis.get(rateLimitKey);
    const attempts = priorAttempts ? parseInt(priorAttempts, 10) : 0;
    if (attempts >= 5) {
      const ttl = await redis.ttl(rateLimitKey);
      const waitMin = ttl > 0 ? Math.ceil(ttl / 60) : 10;
      throw new AppError(
        429,
        'RATE_LIMITED',
        `Too many SIM verification attempts. Try again in about ${waitMin} minute${waitMin === 1 ? '' : 's'}.`,
      );
    }

    const challengeId = crypto.randomUUID();

    const newAttempts = await redis.incr(rateLimitKey);
    if (newAttempts === 1) await redis.expire(rateLimitKey, 900);

    await redis.set(
      keys.simSmsChallenge(userId),
      JSON.stringify({
        challenge_id: challengeId,
        hardware_id: body.hardware_id,
        device_fingerprint: body.device_fingerprint ?? null,
        phone_e164: user.phone_e164,
      }),
      'EX',
      SIM_SMS_TTL_SEC,
    );

    res.json({
      ok: true,
      data: {
        challenge_id: challengeId,
        expires_in: SIM_SMS_TTL_SEC,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /trust/verify/device/sim-sms/complete ───────────────────────────────
// Step 4b — Device auto-read the MSG91 OTP SMS; verify token and complete SIM binding.

const simSmsCompleteSchema = z.object({
  challenge_id: z.string().uuid(),
  msg91_access_token: z.string().min(20),
  hardware_id: z.string().min(1),
  device_fingerprint: z.string().optional(),
  platform: z.enum(['android', 'ios']).default('android'),
});

trustRouter.post('/verify/device/sim-sms/complete', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = simSmsCompleteSchema.parse(req.body);
    const userId = req.user!.sub;
    const redis = getRedis();

    const raw = await redis.get(keys.simSmsChallenge(userId));
    if (!raw) {
      throw new AppError(410, 'SIM_SMS_EXPIRED', 'SIM verification session expired. Tap Retry to try again.');
    }

    const stored = JSON.parse(raw) as {
      challenge_id: string;
      hardware_id: string;
      device_fingerprint: string | null;
      phone_e164: string;
    };

    if (stored.challenge_id !== body.challenge_id) {
      throw new AppError(400, 'SIM_SMS_INVALID', 'SIM verification session mismatch. Tap Retry.');
    }

    if (stored.hardware_id !== body.hardware_id) {
      throw new AppError(400, 'SIM_SMS_INVALID', 'Device mismatch during SIM verification.');
    }

    const verified = await verifyMsg91AccessToken(body.msg91_access_token);
    if (!phonesMatch(verified.phone_e164, stored.phone_e164)) {
      throw new AppError(
        400,
        'SIM_PHONE_MISMATCH',
        'The OTP was not verified for the same phone number on this account.',
      );
    }

    await redis.del(keys.simSmsChallenge(userId));

    const result = await completeDeviceRegistration(userId, {
      platform: body.platform,
      hardware_id: body.hardware_id,
      device_fingerprint: body.device_fingerprint ?? stored.device_fingerprint ?? undefined,
    });

    res.json({ ok: true, data: { ...result, sim_bound: true } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    const coded = err as { code?: string; message?: string };
    if (coded.code === 'MSG91_TOKEN_INVALID') {
      return next(new AppError(401, coded.code, coded.message ?? 'SIM verification OTP was invalid.'));
    }
    next(err);
  }
});

// ─── POST /trust/verify/device/sim-bind ───────────────────────────────────────
// Legacy — SIM phone read from TelephonyManager. Prefer sim-sms flow on mobile.

const simBindSchema = z.object({
  platform: z.enum(['android', 'ios']).default('android'),
  sim_numbers: z.array(z.string()).min(1, 'No SIM phone numbers reported'),
  hardware_id: z.string().min(1),
  device_fingerprint: z.string().optional(),
  push_token: z.string().optional(),
});

async function completeDeviceRegistration(
  userId: string,
  body: {
    platform: 'android' | 'ios';
    hardware_id: string;
    device_fingerprint?: string;
    push_token?: string;
    integrity_token?: string;
  },
): Promise<{ score: number; tier: string }> {
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO device_registrations
         (user_id, platform, integrity_token, push_token, hardware_id, device_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [
        userId,
        body.platform,
        body.integrity_token ?? null,
        body.push_token ?? null,
        body.hardware_id,
        body.device_fingerprint ?? null,
      ],
    );

    await client.query(
      `UPDATE device_registrations
       SET device_fingerprint = $3, push_token = COALESCE($4, push_token), last_seen_at = NOW()
       WHERE user_id = $1 AND hardware_id = $2`,
      [userId, body.hardware_id, body.device_fingerprint ?? null, body.push_token ?? null],
    );

    await client.query(
      `INSERT INTO trust_factors (user_id, factor_type, status, provider, score_delta, verified_at)
       VALUES ($1, 'device_integrity', 'completed', $2, 10, NOW())
       ON CONFLICT (user_id, factor_type) WHERE is_latest = TRUE
       DO UPDATE SET status = 'completed', verified_at = NOW(), provider = EXCLUDED.provider`,
      [userId, body.platform === 'android' ? 'play_integrity' : 'device_check'],
    );
  });

  const breakdown = await recomputeAndPersist(userId);
  return { score: breakdown.total, tier: breakdown.tier };
}

trustRouter.post('/verify/device/sim-bind', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = simBindSchema.parse(req.body);

    const user = await queryOne<{ phone_e164: string }>(
      `SELECT phone_e164 FROM users WHERE user_id = $1`,
      [req.user!.sub],
    );
    if (!user?.phone_e164) {
      throw new AppError(400, 'PHONE_NOT_FOUND', 'Verified phone number not found on your account.');
    }

    const matched = body.sim_numbers.some((n) => phonesMatch(n, user.phone_e164));
    if (!matched) {
      throw new AppError(
        400,
        'SIM_PHONE_MISMATCH',
        'The phone number on this SIM does not match the number you verified with OTP.',
      );
    }

    const existing = await queryOne<{ user_id: string }>(
      `SELECT user_id FROM device_registrations
       WHERE hardware_id = $1 AND user_id != $2
       LIMIT 1`,
      [body.hardware_id, req.user!.sub],
    );
    if (existing) {
      logger.warn('trust', `hardware_id ${body.hardware_id} was previously bound to user ${existing.user_id}`);
    }

    const result = await completeDeviceRegistration(req.user!.sub, {
      platform: body.platform,
      hardware_id: body.hardware_id,
      device_fingerprint: body.device_fingerprint,
      push_token: body.push_token,
    });

    res.json({ ok: true, data: { ...result, sim_bound: true } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /trust/verify/device ────────────────────────────────────────────────
// Legacy combined endpoint — prefer the step-specific routes above.

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
        logger.error('liveness', 'Luxand check failed', { error: err.message });
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
