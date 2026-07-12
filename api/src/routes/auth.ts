import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '@trustroute/shared';
import type { RefreshTokenRow, UserRow } from '@trustroute/shared';
import { AppError } from '../middleware/errorHandler';
import { requireAuth } from '../middleware/auth';
import { assertCanAuthenticate } from '../services/accountState';
import { publicLimiter } from '../middleware/rateLimit';
import {
  assertPinNotLocked,
  clearPinFailures,
  getUserByHandleForLogin,
  isValidPin,
  pinSet,
  recordPinFailure,
  setUserPin,
  verifyPin,
  type UserWithPin,
} from '../services/accountPin';

export const authRouter = Router();

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function authUserPayload(user: UserRow): object {
  return {
    user_id: user.user_id,
    identity_id: user.identity_id,
    handle: user.handle,
    display_name: user.display_name,
    legal_name: user.legal_name,
    trust_tier: user.trust_tier,
    trust_score: user.trust_score,
    avatar_url: user.avatar_url,
    onboarding_complete: user.onboarding_complete ?? false,
    discovery_mode: user.discovery_mode,
    account_status: user.account_status,
    phone_e164: user.phone_e164,
    phone_verified: Boolean(user.phone_e164),
    pin_set: pinSet(user),
  };
}

async function issueLoginResponse(user: UserRow, revokeExisting = true): Promise<object> {
  const { accessToken, refreshToken } = issueTokens(user);
  await withTransaction(async (client) => {
    if (revokeExisting) {
      await client.query(`UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1`, [user.user_id]);
    }
    await client.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [user.user_id, hashToken(refreshToken), new Date(Date.now() + REFRESH_TOKEN_TTL_MS)],
    );
  });
  return {
    ok: true,
    data: {
      access_token: accessToken,
      refresh_token: refreshToken,
      user: authUserPayload(user),
    },
  };
}

const removedAuthRoutes = new Set([
  'POST /register/initiate',
  'POST /register/verify',
  'POST /login/initiate',
  'POST /login/verify',
  'POST /phone/check',
  'POST /otp/send',
  'POST /otp/verify',
  'POST /otp/resend',
  'POST /complete-onboarding',
  'POST /handles/suggest',
]);

authRouter.use((req, _res, next) => {
  const routeKey = `${req.method} ${req.path}`;
  const removedHandleAvailability =
    req.method === 'GET' && /^\/handles\/[^/]+\/available$/.test(req.path);
  if (removedAuthRoutes.has(routeKey) || removedHandleAvailability) {
    return next(new AppError(
      410,
      'LEGACY_AUTH_DISABLED',
      'This sign-in path is no longer available. Verify your identity to continue.',
    ));
  }
  next();
});

let _privateKey: string | null = null;
function getPrivateKey(): string {
  if (!_privateKey) {
    if (process.env.JWT_PRIVATE_KEY_B64) {
      _privateKey = Buffer.from(process.env.JWT_PRIVATE_KEY_B64, 'base64').toString('utf8');
    } else {
      const p = process.env.JWT_PRIVATE_KEY_PATH ?? './keys/private.pem';
      _privateKey = fs.readFileSync(path.resolve(p), 'utf8');
    }
  }
  return _privateKey;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function issueTokens(user: UserRow): { accessToken: string; refreshToken: string } {
  const accessToken = jwt.sign(
    { sub: user.user_id, handle: user.handle, tier: user.trust_tier },
    getPrivateKey(),
    { algorithm: 'RS256', expiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '24h' } as any,
  );
  return { accessToken, refreshToken: crypto.randomBytes(40).toString('base64url') };
}

// ─── POST /auth/login (handle + PIN) ─────────────────────────────────────────

const loginSchema = z.object({
  handle: z.string().min(1).max(40),
  pin: z.string().length(6),
});

authRouter.post('/login', publicLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = loginSchema.parse(req.body ?? {});
    if (!isValidPin(body.pin)) {
      throw new AppError(400, 'PIN_INVALID', 'PIN must be exactly 6 digits.');
    }

    const user = await getUserByHandleForLogin(body.handle);
    // Same generic message whether handle is missing or PIN is wrong (avoid handle enumeration).
    const invalidCreds = () =>
      new AppError(401, 'INVALID_CREDENTIALS', 'Handle or PIN is incorrect.');

    if (!user) throw invalidCreds();
    assertCanAuthenticate(user);

    if (!user.pin_hash) {
      throw new AppError(
        403,
        'PIN_NOT_SET',
        'No login PIN on this account yet. Verify with DigiLocker to set one.',
      );
    }

    // Incomplete signup can still sign in with PIN to finish Setup Complete on this device.
    assertPinNotLocked(user);

    const ok = await verifyPin(body.pin, user.pin_hash);
    if (!ok) {
      await recordPinFailure(user.user_id);
      throw invalidCreds();
    }

    await clearPinFailures(user.user_id);
    const fresh = await queryOne<UserRow>(`SELECT * FROM users WHERE user_id = $1`, [user.user_id]);
    res.json(await issueLoginResponse(fresh ?? user, true));
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /auth/pin/set ───────────────────────────────────────────────────────

const setPinSchema = z.object({
  pin: z.string().length(6),
  confirm_pin: z.string().length(6).optional(),
});

authRouter.post('/pin/set', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = setPinSchema.parse(req.body ?? {});
    if (body.confirm_pin != null && body.confirm_pin !== body.pin) {
      throw new AppError(400, 'PIN_MISMATCH', 'PIN confirmation does not match.');
    }
    if (!isValidPin(body.pin)) {
      throw new AppError(400, 'PIN_INVALID', 'PIN must be exactly 6 digits.');
    }

    const user = await queryOne<UserWithPin>(`SELECT * FROM users WHERE user_id = $1`, [req.user!.sub]);
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'Account not found.');
    assertCanAuthenticate(user);

    if (!user.identity_id || user.kyc_status !== 'verified') {
      throw new AppError(403, 'IDENTITY_REQUIRED', 'Verify your identity before setting a PIN.');
    }

    await setUserPin(user.user_id, body.pin);
    res.json({ ok: true, data: { pin_set: true } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /auth/pin/change (requires current PIN) ─────────────────────────────

const changePinSchema = z.object({
  current_pin: z.string().length(6),
  pin: z.string().length(6),
  confirm_pin: z.string().length(6).optional(),
});

authRouter.post('/pin/change', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = changePinSchema.parse(req.body ?? {});
    if (body.confirm_pin != null && body.confirm_pin !== body.pin) {
      throw new AppError(400, 'PIN_MISMATCH', 'PIN confirmation does not match.');
    }
    if (!isValidPin(body.current_pin) || !isValidPin(body.pin)) {
      throw new AppError(400, 'PIN_INVALID', 'PIN must be exactly 6 digits.');
    }
    if (body.current_pin === body.pin) {
      throw new AppError(400, 'PIN_UNCHANGED', 'New PIN must be different from your current PIN.');
    }

    const user = await queryOne<UserWithPin>(`SELECT * FROM users WHERE user_id = $1`, [req.user!.sub]);
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'Account not found.');
    assertCanAuthenticate(user);

    if (!user.pin_hash) {
      throw new AppError(403, 'PIN_NOT_SET', 'No login PIN on this account yet.');
    }

    assertPinNotLocked(user);

    const ok = await verifyPin(body.current_pin, user.pin_hash);
    if (!ok) {
      await recordPinFailure(user.user_id);
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Current PIN is incorrect.');
    }

    await clearPinFailures(user.user_id);
    await setUserPin(user.user_id, body.pin);
    res.json({ ok: true, data: { pin_set: true } });
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
      [tokenHash],
    );
    if (!stored) {
      throw new AppError(401, 'INVALID_TOKEN', 'Refresh token not found or expired.');
    }
    if (stored.revoked) {
      await query(`UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1`, [stored.user_id]);
      throw new AppError(401, 'SESSION_INVALID', 'Your session has been invalidated. Please sign in again.');
    }
    if (new Date() > stored.expires_at) {
      throw new AppError(401, 'TOKEN_EXPIRED', 'Refresh token expired.');
    }

    const user = await queryOne<UserRow>(`SELECT * FROM users WHERE user_id = $1`, [stored.user_id]);
    if (!user) throw new AppError(401, 'USER_INACTIVE', 'Account not found or inactive.');
    assertCanAuthenticate(user);

    const { accessToken, refreshToken: newRefreshToken } = issueTokens(user);

    await withTransaction(async (client) => {
      await client.query(`UPDATE refresh_tokens SET revoked = TRUE WHERE token_id = $1`, [stored.token_id]);
      await client.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
        [user.user_id, hashToken(newRefreshToken), new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)],
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

// ─── POST /auth/logout ────────────────────────────────────────────────────────

authRouter.post('/logout', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refresh_token } = z.object({ refresh_token: z.string() }).parse(req.body);
    await query(
      `UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = $1 AND user_id = $2`,
      [hashToken(refresh_token), req.user!.sub],
    );
    res.json({ ok: true, data: null });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

/** Revoke every refresh token for this user (all devices). */
authRouter.post('/logout-all', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await query(`UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1`, [req.user!.sub]);
    res.json({ ok: true, data: { revoked: true } });
  } catch (err) {
    next(err);
  }
});

const registerDeviceSchema = z.object({
  platform: z.enum(['ios', 'android']),
  device_fingerprint: z.string().min(8).max(500).optional(),
  push_token: z.string().max(500).optional(),
});

authRouter.post('/device', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = registerDeviceSchema.parse(req.body ?? {});
    const fp = body.device_fingerprint
      ? crypto.createHash('sha256').update(body.device_fingerprint).digest('hex')
      : null;
    if (fp) {
      const existing = await queryOne<{ device_id: string }>(
        `SELECT device_id FROM device_registrations WHERE user_id = $1 AND device_fingerprint = $2`,
        [req.user!.sub, fp],
      );
      if (existing) {
        await query(
          `UPDATE device_registrations
              SET last_seen_at = NOW(),
                  push_token = COALESCE($2, push_token),
                  platform = $3
            WHERE device_id = $1`,
          [existing.device_id, body.push_token ?? null, body.platform],
        );
      } else {
        await query(
          `INSERT INTO device_registrations (user_id, platform, device_fingerprint, push_token)
           VALUES ($1, $2, $3, $4)`,
          [req.user!.sub, body.platform, fp, body.push_token ?? null],
        );
      }
    } else {
      await query(
        `INSERT INTO device_registrations (user_id, platform, push_token)
         VALUES ($1, $2, $3)`,
        [req.user!.sub, body.platform, body.push_token ?? null],
      );
    }
    res.json({ ok: true, data: { registered: true } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});
