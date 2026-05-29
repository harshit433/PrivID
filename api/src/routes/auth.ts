import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { query, queryOne, withTransaction, getRedis, keys } from '@privid/shared';
import type { OtpSessionRow, UserRow, RefreshTokenRow } from '@privid/shared';
import { AppError } from '../middleware/errorHandler';
import { requireAuth } from '../middleware/auth';
import { verifyMsg91AccessToken } from '../services/msg91';
import { recomputeAndPersist } from '../services/trustScore';
import { buildHandleCandidates } from '../utils/handles';

export const authRouter = Router();

async function markPhoneVerified(userId: string): Promise<void> {
  await query(
    `INSERT INTO trust_factors (user_id, factor_type, status, provider, score_delta, verified_at)
     VALUES ($1, 'phone_verified', 'completed', 'msg91', 15, NOW())
     ON CONFLICT (user_id, factor_type) WHERE is_latest = TRUE
     DO UPDATE SET status = 'completed', verified_at = NOW(), provider = 'msg91'`,
    [userId]
  );
  await recomputeAndPersist(userId);
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
        },
      },
    },
  };
}

// ─── Key helpers ──────────────────────────────────────────────────────────────

let _privateKey: string | null = null;
function getPrivateKey(): string {
  if (!_privateKey) {
    const p = process.env.JWT_PRIVATE_KEY_PATH ?? './keys/private.pem';
    _privateKey = fs.readFileSync(path.resolve(p), 'utf8');
  }
  return _privateKey;
}

function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function issueTokens(user: UserRow): { accessToken: string; refreshToken: string } {
  const accessToken = jwt.sign(
    { sub: user.user_id, handle: user.handle, tier: user.trust_tier },
    getPrivateKey(),
    { algorithm: 'RS256', expiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '24h' }
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
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[DEV] OTP for ${phone_e164}: ${otp}`);
    }

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
      // Upsert user (phone already registered = login flow)
      const { rows } = await client.query<UserRow>(
        `INSERT INTO users (phone_e164, phone_hash, handle, display_name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (phone_e164) DO UPDATE
           SET updated_at = NOW()
         RETURNING *`,
        [session.phone_e164, phone_hash, handle, display_name ?? handle]
      );
      return rows[0];
    });

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

    if (process.env.NODE_ENV !== 'production') console.log(`[DEV] Login OTP for ${phone_e164}: ${otp}`);

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
      `SELECT * FROM refresh_tokens WHERE token_hash = $1 AND revoked = FALSE`,
      [tokenHash]
    );
    if (!stored) throw new AppError(401, 'INVALID_TOKEN', 'Refresh token not found or revoked.');
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
  const available: string[] = [];
  for (const handle of candidates) {
    const taken = await queryOne(`SELECT handle FROM users WHERE handle = $1`, [handle]);
    if (!taken) available.push(handle);
    if (available.length >= limit) break;
  }
  return available;
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

// ─── POST /auth/logout ────────────────────────────────────────────────────────

authRouter.post('/logout', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refresh_token } = z.object({ refresh_token: z.string() }).parse(req.body);
    await query(
      `UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = $1`,
      [hashToken(refresh_token)]
    );
    res.json({ ok: true, data: null });
  } catch (err) {
    next(err);
  }
});
