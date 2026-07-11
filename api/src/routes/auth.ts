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

export const authRouter = Router();

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
