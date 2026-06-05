import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { query, queryOne, withTransaction, getRedis, keys } from '@trustroute/shared';
import type { OtpSessionRow, UserRow, RefreshTokenRow, ShadowNumberRow } from '@trustroute/shared';
import { AppError } from '../middleware/errorHandler';
import { requireAuth } from '../middleware/auth';
import { verifyMsg91AccessToken, sendLoginOtpSms } from '../services/msg91';
import { finalizeTrustFactor } from '../services/trustScore';
import { buildHandleCandidates } from '../utils/handles';
import { logger } from '../utils/logger';

export const authRouter = Router();

// ─── Shadow reputation bootstrap ─────────────────────────────────────────────
//
// Called once when a new user completes registration. Checks whether their
// phone number has a pre-existing shadow score (from crowd-sourced dialer data)
// and, if significant, records it as a `shadow_reputation` trust_factor.
//
// Score mapping (shadow_score → delta applied to starting trust score):
//   0–20  SPAM:       -20 (they start significantly below baseline)
//  21–35  SUSPICIOUS: -10
//  36–49  BELOW AVG:   -5
//  50–64  NEUTRAL:      0 (no factor inserted)
//  65–79  GOOD:        +3
//  80–100 TRUSTED:     +7 (capped low to prevent gaming)
//
// A minimum of 5 observations is required before the shadow score diverges
// from the neutral baseline of 50.

async function applyShadowReputation(userId: string, phoneHash: string): Promise<void> {
  const shadow = await queryOne<ShadowNumberRow>(
    `SELECT shadow_score, observation_count, block_rate
       FROM shadow_numbers
      WHERE phone_hash = $1`,
    [phoneHash],
  );

  if (!shadow || shadow.observation_count < 5) return; // insufficient data

  let delta = 0;
  const s = shadow.shadow_score;
  if      (s <= 20) delta = -20;
  else if (s <= 35) delta = -10;
  else if (s <= 49) delta = -5;
  else if (s >= 80) delta = 7;
  else if (s >= 65) delta = 3;
  // 50–64: neutral → no factor

  if (delta === 0) return;

  // Insert shadow_reputation trust factor (is_latest = TRUE, no conflict expected
  // since this is a fresh registration)
  await query(
    `INSERT INTO trust_factors
           (user_id, factor_type, status, score_delta, provider, metadata, verified_at, is_latest)
     VALUES ($1, 'shadow_reputation', 'completed', $2, 'shadow_network', $3, NOW(), TRUE)
     ON CONFLICT DO NOTHING`,
    [
      userId,
      delta,
      JSON.stringify({
        shadow_score:      shadow.shadow_score,
        observation_count: shadow.observation_count,
        block_rate:        shadow.block_rate,
      }),
    ],
  );

  logger.info('auth/register', 'Applied shadow reputation factor', {
    userId,
    shadow_score: shadow.shadow_score,
    delta,
    observations: shadow.observation_count,
  });
}

// ─── Trust factor helpers ─────────────────────────────────────────────────────

async function markPhoneVerified(userId: string): Promise<void> {
  await query(
    `INSERT INTO trust_factors (user_id, factor_type, status, provider, score_delta, verified_at)
     VALUES ($1, 'phone_verified', 'completed', 'msg91', 15, NOW())
     ON CONFLICT (user_id, factor_type) WHERE is_latest = TRUE
     DO UPDATE SET status = 'completed', verified_at = NOW(), provider = 'msg91'`,
    [userId]
  );
  await finalizeTrustFactor(userId, 'phone_verified');
}

async function issueAuthResponse(
  user: UserRow,
  statusCode: 200 | 201 = 200
): Promise<{ statusCode: 200 | 201; body: object }> {
  const { accessToken, refreshToken } = issueTokens(user);
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [user.user_id, hashToken(refreshToken), new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)]
  );
  return {
    statusCode,
    body: {
      ok: true,
      data: {
        access_token: accessToken,
        refresh_token: refreshToken,
        user: {
          user_id: user.user_id,
          handle: user.handle,
          display_name: user.display_name,
          trust_tier: user.trust_tier,
          trust_score: user.trust_score,
          onboarding_complete: user.onboarding_complete ?? false,
        },
      },
    },
  };
}

// ─── Key helpers ──────────────────────────────────────────────────────────────

let _privateKey: string | null = null;
function getPrivateKey(): string {
  if (!_privateKey) {
    // Prefer base64-encoded env var (Railway/cloud) over file path
    if (process.env.JWT_PRIVATE_KEY_B64) {
      _privateKey = Buffer.from(process.env.JWT_PRIVATE_KEY_B64, 'base64').toString('utf8');
    } else {
      const p = process.env.JWT_PRIVATE_KEY_PATH ?? './keys/private.pem';
      _privateKey = fs.readFileSync(path.resolve(p), 'utf8');
    }
  }
  return _privateKey;
}

function generateOtp(): string {
  return crypto.randomInt(100_000, 1_000_000).toString();
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function issueTokens(user: UserRow): { accessToken: string; refreshToken: string } {
  // Cast options to any to handle StringValue type constraint in newer @types/jsonwebtoken.
  // The values are valid JWT duration strings; the cast is intentional.
  const jwtOptions: any = {
    algorithm: 'RS256',
    expiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '24h',
  };
  const accessToken = jwt.sign(
    { sub: user.user_id, handle: user.handle, tier: user.trust_tier },
    getPrivateKey(),
    jwtOptions,
  );
  const refreshToken = crypto.randomBytes(40).toString('base64url');
  return { accessToken, refreshToken };
}

// ─── POST /auth/register/initiate ─────────────────────────────────────────────

const initiateSchema = z.object({
  phone_e164: z.string().regex(/^\+[1-9]\d{7,14}$/, 'Invalid phone number'),
});

authRouter.post('/register/initiate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { phone_e164 } = initiateSchema.parse(req.body);
    const redis = getRedis();

    // Rate limit: 3 OTPs per phone per 10 minutes
    const rateLimitKey = keys.rateLimitOtp(phone_e164);
    const attempts = await redis.incr(rateLimitKey);
    if (attempts === 1) await redis.expire(rateLimitKey, 600);
    if (attempts > 3) {
      throw new AppError(429, 'RATE_LIMITED', 'Too many OTP requests. Try again in 10 minutes.');
    }

    const otp = generateOtp();
    const otp_hash = await bcrypt.hash(otp, 10);
    const expires_at = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    const [session] = await query<{ session_id: string }>(
      `INSERT INTO otp_sessions (phone_e164, otp_hash, expires_at)
       VALUES ($1, $2, $3)
       RETURNING session_id`,
      [phone_e164, otp_hash, expires_at]
    );

    // In production: send OTP via SMS provider

    res.json({
      ok: true,
      data: {
        session_id: session.session_id,
        expires_in: 600,
        ...(process.env.NODE_ENV !== 'production' && { _dev_otp: otp }),
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    }
    next(err);
  }
});

// ─── POST /auth/register/verify ───────────────────────────────────────────────

const verifySchema = z.object({
  session_id: z.string().uuid(),
  otp: z.string().length(6),
  handle: z.string().min(3).max(30).regex(/^[a-z0-9_]+$/, 'Handle: lowercase letters, numbers, underscores only'),
  display_name: z.string().min(1).max(60).optional(),
});

authRouter.post('/register/verify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { session_id, otp, handle, display_name } = verifySchema.parse(req.body);

    const session = await queryOne<OtpSessionRow>(
      `SELECT * FROM otp_sessions WHERE session_id = $1 AND verified = FALSE`,
      [session_id]
    );

    if (!session) throw new AppError(404, 'SESSION_NOT_FOUND', 'OTP session not found or already used.');
    if (new Date() > session.expires_at) throw new AppError(410, 'SESSION_EXPIRED', 'OTP has expired.');
    if (session.attempts >= 5) throw new AppError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed attempts.');

    const valid = await bcrypt.compare(otp, session.otp_hash);
    if (!valid) {
      await query(`UPDATE otp_sessions SET attempts = attempts + 1 WHERE session_id = $1`, [session_id]);
      throw new AppError(401, 'INVALID_OTP', 'Incorrect OTP.');
    }

    // Mark session verified
    await query(`UPDATE otp_sessions SET verified = TRUE WHERE session_id = $1`, [session_id]);

    // Check if handle is taken
    const existing = await queryOne(`SELECT handle FROM users WHERE handle = $1`, [handle]);
    if (existing) throw new AppError(409, 'HANDLE_TAKEN', 'This handle is already taken.');

    const phone_hash = crypto.createHash('sha256').update(session.phone_e164).digest('hex');

    const user = await withTransaction(async (client) => {
      const { rows } = await client.query<UserRow>(
        `INSERT INTO users (phone_e164, phone_hash, handle, display_name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (phone_e164) DO NOTHING
         RETURNING *`,
        [session.phone_e164, phone_hash, handle, display_name ?? handle]
      );
      // If rows is empty, this phone is already registered — route to login instead
      if (!rows[0]) {
        throw new AppError(409, 'PHONE_REGISTERED', 'This number is already registered. Please log in instead.');
      }
      return rows[0];
    });

    // ── Shadow reputation bootstrap ───────────────────────────────────────────
    // When a NEW user joins, check if their phone_hash has a shadow score from
    // crowd-sourced dialer observations. Apply as a starting trust modifier so
    // known spammers don't start from a neutral 50.
    // Best-effort: errors here must never block registration.
    applyShadowReputation(user.user_id, phone_hash).catch((e) =>
      logger.warn('auth/register', 'Shadow reputation check failed (non-fatal)', { error: e.message })
    );

    const { accessToken, refreshToken } = issueTokens(user);
    const refreshHash = hashToken(refreshToken);
    const refreshExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [user.user_id, refreshHash, refreshExpiry]
    );

    res.status(201).json({
      ok: true,
      data: {
        access_token: accessToken,
        refresh_token: refreshToken,
        user: {
          user_id: user.user_id,
          handle: user.handle,
          display_name: user.display_name,
          trust_tier: user.trust_tier,
          trust_score: user.trust_score,
          onboarding_complete: user.onboarding_complete ?? false,
        },
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    }
    next(err);
  }
});

// ─── POST /auth/login/initiate ────────────────────────────────────────────────

authRouter.post('/login/initiate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { phone_e164 } = initiateSchema.parse(req.body);

    const user = await queryOne<UserRow>(`SELECT * FROM users WHERE phone_e164 = $1`, [phone_e164]);
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'No account found for this phone number.');

    const redis = getRedis();
    const rateLimitKey = keys.rateLimitOtp(phone_e164);
    const attempts = await redis.incr(rateLimitKey);
    if (attempts === 1) await redis.expire(rateLimitKey, 600);
    if (attempts > 3) throw new AppError(429, 'RATE_LIMITED', 'Too many OTP requests.');

    const otp = generateOtp();
    const otp_hash = await bcrypt.hash(otp, 10);
    const expires_at = new Date(Date.now() + 10 * 60 * 1000);

    const [session] = await query<{ session_id: string }>(
      `INSERT INTO otp_sessions (phone_e164, otp_hash, expires_at) VALUES ($1, $2, $3) RETURNING session_id`,
      [phone_e164, otp_hash, expires_at]
    );

    res.json({
      ok: true,
      data: {
        session_id: session.session_id,
        expires_in: 600,
        ...(process.env.NODE_ENV !== 'production' && { _dev_otp: otp }),
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /auth/login/verify ──────────────────────────────────────────────────

const loginVerifySchema = z.object({
  session_id: z.string().uuid(),
  otp: z.string().length(6),
});

authRouter.post('/login/verify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { session_id, otp } = loginVerifySchema.parse(req.body);

    const session = await queryOne<OtpSessionRow>(
      `SELECT * FROM otp_sessions WHERE session_id = $1 AND verified = FALSE`,
      [session_id]
    );
    if (!session) throw new AppError(404, 'SESSION_NOT_FOUND', 'OTP session not found.');
    if (new Date() > session.expires_at) throw new AppError(410, 'SESSION_EXPIRED', 'OTP expired.');
    if (session.attempts >= 5) throw new AppError(429, 'TOO_MANY_ATTEMPTS', 'Too many attempts.');

    const valid = await bcrypt.compare(otp, session.otp_hash);
    if (!valid) {
      await query(`UPDATE otp_sessions SET attempts = attempts + 1 WHERE session_id = $1`, [session_id]);
      throw new AppError(401, 'INVALID_OTP', 'Incorrect OTP.');
    }

    await query(`UPDATE otp_sessions SET verified = TRUE WHERE session_id = $1`, [session_id]);

    const user = await queryOne<UserRow>(`SELECT * FROM users WHERE phone_e164 = $1`, [session.phone_e164]);
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'Account not found.');

    const { accessToken, refreshToken } = issueTokens(user);
    await query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [user.user_id, hashToken(refreshToken), new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)]
    );

    res.json({
      ok: true,
      data: {
        access_token: accessToken,
        refresh_token: refreshToken,
        user: {
          user_id: user.user_id,
          handle: user.handle,
          display_name: user.display_name,
          trust_tier: user.trust_tier,
          trust_score: user.trust_score,
        },
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /auth/token/refresh ─────────────────────────────────────────────────

authRouter.post('/token/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refresh_token } = z.object({ refresh_token: z.string() }).parse(req.body);

    const tokenHash = hashToken(refresh_token);
    const stored = await queryOne<RefreshTokenRow>(
      `SELECT * FROM refresh_tokens WHERE token_hash = $1`,
      [tokenHash]
    );
    if (!stored) {
      throw new AppError(401, 'INVALID_TOKEN', 'Refresh token not found or expired.');
    }
    if (stored.revoked) {
      // Token was already revoked — possible theft. Revoke all sessions for this user.
      await query(
        `UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1`,
        [stored.user_id]
      );
      throw new AppError(401, 'SESSION_INVALID', 'Your session has been invalidated for security reasons. Please sign in again.');
    }
    if (new Date() > stored.expires_at) throw new AppError(401, 'TOKEN_EXPIRED', 'Refresh token expired.');

    // Rotate: revoke old, issue new
    const user = await queryOne<UserRow>(`SELECT * FROM users WHERE user_id = $1`, [stored.user_id]);
    if (!user || !user.is_active) throw new AppError(401, 'USER_INACTIVE', 'Account not found or inactive.');

    const { accessToken, refreshToken: newRefreshToken } = issueTokens(user);

    await withTransaction(async (client) => {
      await client.query(`UPDATE refresh_tokens SET revoked = TRUE WHERE token_id = $1`, [stored.token_id]);
      await client.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
        [user.user_id, hashToken(newRefreshToken), new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)]
      );
    });

    res.json({
      ok: true,
      data: { access_token: accessToken, refresh_token: newRefreshToken },
    });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /auth/phone/check ───────────────────────────────────────────────────
// Used before sending OTP to block signup for registered numbers (and login for unknown).

const phoneCheckSchema = z.object({
  phone_e164: z.string().regex(/^\+[1-9]\d{7,14}$/, 'Invalid phone number'),
});

authRouter.post('/phone/check', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { phone_e164 } = phoneCheckSchema.parse(req.body);
    const user = await queryOne<UserRow>(
      `SELECT user_id FROM users WHERE phone_e164 = $1 AND is_active = TRUE`,
      [phone_e164]
    );
    res.json({ ok: true, data: { registered: Boolean(user) } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /auth/handles/suggest ───────────────────────────────────────────────

async function filterAvailableHandles(candidates: string[], limit: number): Promise<string[]> {
  if (candidates.length === 0) return [];
  const rows = await query<{ handle: string }>(
    `SELECT handle FROM users WHERE handle = ANY($1::text[])`,
    [candidates],
  );
  const taken = new Set(rows.map((r) => r.handle));
  return candidates.filter((h) => !taken.has(h)).slice(0, limit);
}

authRouter.post('/handles/suggest', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, limit } = z
      .object({
        name: z.string().min(1).max(60),
        limit: z.number().int().min(1).max(8).optional(),
      })
      .parse(req.body);

    const max = limit ?? 5;
    let candidates = buildHandleCandidates(name);

    // Pad with extra random variants if the name yields few unique bases
    const first = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'user';
    let attempts = 0;
    while (candidates.length < max + 4 && attempts < 12) {
      const suffix = String(Math.floor(1000 + Math.random() * 9000));
      candidates.push(`${first}_${suffix}`.slice(0, 30));
      candidates = [...new Set(candidates)];
      attempts++;
    }

    const suggestions = await filterAvailableHandles(candidates, max);
    res.json({ ok: true, data: { suggestions } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── GET /auth/handles/:handle/available ──────────────────────────────────────

authRouter.get('/handles/:handle/available', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const handle = req.params.handle.toLowerCase();
    if (!/^[a-z0-9_]{3,30}$/.test(handle)) {
      return res.json({ ok: true, data: { available: false } });
    }
    const taken = await queryOne(`SELECT handle FROM users WHERE handle = $1`, [handle]);
    res.json({ ok: true, data: { available: !taken } });
  } catch (err) {
    next(err);
  }
});

// ─── POST /auth/otp/send ─────────────────────────────────────────────────────
// Server generates a 6-digit OTP, stores the hash in Redis, and delivers the
// code via MSG91's OTP API. No MSG91 widget credentials required on the client.

const OTP_SESSION_TTL_SEC = 10 * 60; // 10 min
const OTP_MAX_ATTEMPTS = 5;
const OTP_RATE_LIMIT = 5; // per 10-min window

const otpSendSchema = z.object({
  phone_e164: z.string().regex(/^\+[1-9]\d{7,14}$/, 'Invalid phone number'),
  mode: z.enum(['signup', 'login']),
});

authRouter.post('/otp/send', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { phone_e164, mode } = otpSendSchema.parse(req.body);
    const redis = getRedis();

    // Registration check
    const existingUser = await queryOne<UserRow>(
      `SELECT user_id FROM users WHERE phone_e164 = $1 AND is_active = TRUE`,
      [phone_e164],
    );
    if (mode === 'signup' && existingUser) {
      throw new AppError(409, 'PHONE_REGISTERED', 'This number is already registered. Log in instead.');
    }
    if (mode === 'login' && !existingUser) {
      throw new AppError(404, 'USER_NOT_FOUND', 'No account found for this number. Sign up instead.');
    }

    // Rate limit: 5 sends per phone per 10 minutes
    const rateLimitKey = keys.rateLimitOtp(phone_e164);
    const attempts = await redis.incr(rateLimitKey);
    if (attempts === 1) await redis.expire(rateLimitKey, 600);
    if (attempts > OTP_RATE_LIMIT) {
      throw new AppError(429, 'RATE_LIMITED', 'Too many OTP requests. Try again in 10 minutes.');
    }

    const sessionId = crypto.randomUUID();
    const otp = generateOtp();
    const otp_hash = await bcrypt.hash(otp, 10);

    await redis.setex(
      keys.otpSession(sessionId),
      OTP_SESSION_TTL_SEC,
      JSON.stringify({ phone_e164, otp_hash, attempts: 0, mode }),
    );

    // Keep SMS validity aligned with server-side OTP session TTL.
    await sendLoginOtpSms(phone_e164, otp, { otpExpiryMinutes: Math.ceil(OTP_SESSION_TTL_SEC / 60) });

    res.json({
      ok: true,
      data: {
        session_id: sessionId,
        expires_in: OTP_SESSION_TTL_SEC,
        ...(process.env.NODE_ENV !== 'production' && { _dev_otp: otp }),
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /auth/otp/verify ────────────────────────────────────────────────────
// Verifies the OTP the user typed against our Redis-stored hash.
// Returns TrustRoute JWTs on success (or needs_handle for new users).

const otpVerifySchema = z.object({
  session_id: z.string().uuid(),
  otp: z.string().length(6),
});

authRouter.post('/otp/verify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { session_id, otp } = otpVerifySchema.parse(req.body);
    const redis = getRedis();

    const raw = await redis.get(keys.otpSession(session_id));
    if (!raw) {
      throw new AppError(404, 'SESSION_NOT_FOUND', 'OTP session not found or expired. Please request a new code.');
    }

    const session = JSON.parse(raw) as {
      phone_e164: string;
      otp_hash: string;
      attempts: number;
      mode: string;
    };

    if (session.attempts >= OTP_MAX_ATTEMPTS) {
      await redis.del(keys.otpSession(session_id));
      throw new AppError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed attempts. Please request a new code.');
    }

    const valid = await bcrypt.compare(otp, session.otp_hash);
    if (!valid) {
      session.attempts += 1;
      await redis.setex(keys.otpSession(session_id), OTP_SESSION_TTL_SEC, JSON.stringify(session));
      const remaining = OTP_MAX_ATTEMPTS - session.attempts;
      throw new AppError(
        401,
        'INVALID_OTP',
        remaining > 0
          ? `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
          : 'Incorrect code.',
      );
    }

    // OTP verified — consume session
    await redis.del(keys.otpSession(session_id));
    const { phone_e164 } = session;

    const existing = await queryOne<UserRow>(
      `SELECT * FROM users WHERE phone_e164 = $1 AND is_active = TRUE`,
      [phone_e164],
    );

    if (existing) {
      await markPhoneVerified(existing.user_id);
      const updated = await queryOne<UserRow>(`SELECT * FROM users WHERE user_id = $1`, [existing.user_id]);
      const { statusCode, body } = await issueAuthResponse(updated ?? existing);
      return res.status(statusCode).json(body);
    }

    // New user — store pending signup, ask for handle
    const signup_token = crypto.randomUUID();
    await redis.setex(
      keys.msg91SignupPending(signup_token),
      MSG91_SIGNUP_TTL_SEC,
      JSON.stringify({ phone_e164 }),
    );
    return res.json({ ok: true, data: { needs_handle: true, phone_e164, signup_token } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /auth/otp/resend ────────────────────────────────────────────────────
// Generates a fresh OTP for an existing session (same session_id, new code).

const otpResendSchema = z.object({
  session_id: z.string().uuid(),
});

authRouter.post('/otp/resend', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { session_id } = otpResendSchema.parse(req.body);
    const redis = getRedis();

    const raw = await redis.get(keys.otpSession(session_id));
    if (!raw) {
      throw new AppError(404, 'SESSION_NOT_FOUND', 'OTP session not found or expired. Please request a new code.');
    }

    const session = JSON.parse(raw) as { phone_e164: string; otp_hash: string; attempts: number; mode: string };
    const { phone_e164 } = session;

    // Resend rate limit: reuse the same per-phone rate limit key
    const rateLimitKey = keys.rateLimitOtp(phone_e164);
    const count = await redis.incr(rateLimitKey);
    if (count === 1) await redis.expire(rateLimitKey, 600);
    if (count > OTP_RATE_LIMIT) {
      throw new AppError(429, 'RATE_LIMITED', 'Too many OTP requests. Try again in 10 minutes.');
    }

    const otp = generateOtp();
    const otp_hash = await bcrypt.hash(otp, 10);
    const updated = { ...session, otp_hash, attempts: 0 };

    await redis.setex(keys.otpSession(session_id), OTP_SESSION_TTL_SEC, JSON.stringify(updated));
    await sendLoginOtpSms(phone_e164, otp);

    res.json({
      ok: true,
      data: {
        session_id,
        expires_in: OTP_SESSION_TTL_SEC,
        ...(process.env.NODE_ENV !== 'production' && { _dev_otp: otp }),
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /auth/msg91/verify ─────────────────────────────────────────────────
// After MSG91 OTPWidget.verifyOTP on the client, exchange the access-token for PrivID JWTs.

const MSG91_SIGNUP_TTL_SEC = 15 * 60;

const msg91VerifySchema = z
  .object({
    access_token: z.string().min(1).optional(),
    signup_token: z.string().uuid().optional(),
    phone_e164: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(),
    handle: z.string().min(3).max(30).regex(/^[a-z0-9_]+$/).optional(),
    display_name: z.string().min(1).max(60).optional(),
  })
  .refine((d) => Boolean(d.access_token) !== Boolean(d.signup_token), {
    message: 'Provide either access_token or signup_token',
  });

async function createUserWithHandle(
  phone: string,
  handle: string,
  display_name?: string
): Promise<{ statusCode: 200 | 201; body: object }> {
  const taken = await queryOne(`SELECT handle FROM users WHERE handle = $1`, [handle]);
  if (taken) throw new AppError(409, 'HANDLE_TAKEN', 'This handle is already taken.');

  const phone_hash = crypto.createHash('sha256').update(phone).digest('hex');
  const user = await withTransaction(async (client) => {
    const { rows } = await client.query<UserRow>(
      `INSERT INTO users (phone_e164, phone_hash, handle, display_name)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [phone, phone_hash, handle, display_name ?? handle]
    );
    return rows[0];
  });

  await markPhoneVerified(user.user_id);
  const refreshed = await queryOne<UserRow>(`SELECT * FROM users WHERE user_id = $1`, [user.user_id]);
  return issueAuthResponse(refreshed ?? user, 201);
}

authRouter.post('/msg91/verify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = msg91VerifySchema.parse(req.body);
    const { handle, display_name, phone_e164 } = parsed;

    // ── Complete signup using one-time token (MSG91 JWT already consumed) ──
    if (parsed.signup_token) {
      if (!handle) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Handle is required to complete signup.');
      }
      const name = display_name?.trim();
      if (!name || name.length < 2) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Display name is required (at least 2 characters).');
      }

      const redis = getRedis();
      const pendingKey = keys.msg91SignupPending(parsed.signup_token);
      const pendingRaw = await redis.get(pendingKey);
      if (!pendingRaw) {
        throw new AppError(
          401,
          'SIGNUP_EXPIRED',
          'Phone verification expired. Please verify your phone number again.'
        );
      }

      const pending = JSON.parse(pendingRaw) as { phone_e164: string };
      const phone = pending.phone_e164;
      if (phone_e164 && phone_e164 !== phone) {
        throw new AppError(400, 'PHONE_MISMATCH', 'Verified phone does not match the number entered.');
      }

      const existing = await queryOne<UserRow>(
        `SELECT * FROM users WHERE phone_e164 = $1 AND is_active = TRUE`,
        [phone]
      );
      if (existing) {
        await redis.del(pendingKey);
        await markPhoneVerified(existing.user_id);
        const updated = await queryOne<UserRow>(`SELECT * FROM users WHERE user_id = $1`, [existing.user_id]);
        const { statusCode, body } = await issueAuthResponse(updated ?? existing);
        return res.status(statusCode).json(body);
      }

      const { statusCode, body } = await createUserWithHandle(phone, handle, name);
      await redis.del(pendingKey);
      return res.status(statusCode).json(body);
    }

    // ── Verify MSG91 access-token (single-use) ──
    const access_token = parsed.access_token!;
    const verified = await verifyMsg91AccessToken(access_token).catch((err: Error & { code?: string }) => {
      throw new AppError(401, err.code ?? 'MSG91_TOKEN_INVALID', err.message);
    });

    const phone = verified.phone_e164;
    if (phone_e164 && phone_e164 !== phone) {
      throw new AppError(400, 'PHONE_MISMATCH', 'Verified phone does not match the number entered.');
    }

    const existing = await queryOne<UserRow>(
      `SELECT * FROM users WHERE phone_e164 = $1 AND is_active = TRUE`,
      [phone]
    );

    if (existing) {
      await markPhoneVerified(existing.user_id);
      const updated = await queryOne<UserRow>(
        `SELECT * FROM users WHERE user_id = $1`,
        [existing.user_id]
      );
      const { statusCode, body } = await issueAuthResponse(updated ?? existing);
      return res.status(statusCode).json(body);
    }

    if (!handle) {
      const signup_token = crypto.randomUUID();
      const redis = getRedis();
      await redis.setex(
        keys.msg91SignupPending(signup_token),
        MSG91_SIGNUP_TTL_SEC,
        JSON.stringify({ phone_e164: phone })
      );
      return res.json({ ok: true, data: { needs_handle: true, phone_e164: phone, signup_token } });
    }

    const { statusCode, body } = await createUserWithHandle(phone, handle, display_name);
    return res.status(statusCode).json(body);
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /auth/complete-onboarding ──────────────────────────────────────────
// Called by SetupCompleteScreen once the user has finished the full setup flow.
// Marks onboarding_complete = TRUE so future logins go straight to Main.

authRouter.post('/complete-onboarding', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;

    const factors = await query<{ factor_type: string; status: string }>(
      `SELECT factor_type, status FROM trust_factors
       WHERE user_id = $1 AND is_latest = TRUE`,
      [userId]
    );
    const byType = Object.fromEntries(factors.map((f) => [f.factor_type, f.status]));
    const required: Array<{ type: string; label: string }> = [
      { type: 'phone_verified', label: 'Phone verification' },
      { type: 'device_integrity', label: 'Device verification' },
      { type: 'liveness_check', label: 'Liveness check' },
    ];
    for (const step of required) {
      if (byType[step.type] !== 'completed') {
        throw new AppError(
          400,
          'ONBOARDING_INCOMPLETE',
          `${step.label} must be completed before finishing setup.`
        );
      }
    }

    await query(
      `UPDATE users SET onboarding_complete = TRUE, updated_at = NOW() WHERE user_id = $1`,
      [userId]
    );
    res.json({ ok: true, data: { onboarding_complete: true } });
  } catch (err) {
    next(err);
  }
});

// ─── POST /auth/logout ────────────────────────────────────────────────────────

authRouter.post('/logout', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refresh_token } = z.object({ refresh_token: z.string() }).parse(req.body);
    await query(
      `UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = $1 AND user_id = $2`,
      [hashToken(refresh_token), req.user!.sub]
    );
    res.json({ ok: true, data: null });
  } catch (err) {
    next(err);
  }
});
