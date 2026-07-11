/**
 * api/src/middleware/auth.ts
 *
 * JWT verification + presence heartbeat.
 *
 * On every authenticated request we fire a non-blocking last_seen_at update
 * throttled to at most one PostgreSQL write per 2 minutes per user (via Redis
 * SETNX). The actual DB write is fire-and-forget: it never delays the response.
 *
 * Presence key shape: presence:{user_id}  TTL: 120 s  Value: '1'
 */

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { AccessTokenPayload, getRedis, query, queryOne, keys } from '@trustroute/shared';
import type { UserRow } from '@trustroute/shared';
import { AppError } from './errorHandler';
import { assertCanAuthenticate } from '../services/accountState';

// ─── JWT key loading ──────────────────────────────────────────────────────────

let publicKey: string | null = null;

function getPublicKey(): string {
  if (!publicKey) {
    if (process.env.JWT_PUBLIC_KEY_B64) {
      publicKey = Buffer.from(process.env.JWT_PUBLIC_KEY_B64, 'base64').toString('utf8');
    } else {
      const keyPath = process.env.JWT_PUBLIC_KEY_PATH ?? './keys/public.pem';
      publicKey = fs.readFileSync(path.resolve(keyPath), 'utf8');
    }
  }
  return publicKey;
}

// ─── Type augmentation ────────────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      user?: AccessTokenPayload;
    }
  }
}

// ─── Presence heartbeat (non-blocking) ───────────────────────────────────────

/**
 * Update last_seen_at in PostgreSQL at most once every 2 minutes per user.
 *
 * Uses Redis SETNX as a cheap gate:
 *   • If key is absent (NX):  write to DB, set key with 120 s TTL.
 *   • If key exists:          DB was recently updated; skip.
 *
 * Errors are swallowed — presence is best-effort and must never break a request.
 */
function touchPresence(userId: string): void {
  const presenceKey = keys.presence(userId);

  setImmediate(async () => {
    try {
      const redis = getRedis();
      // SET … NX EX: atomic "set-if-not-exists with expiry"
      const set = await redis.set(presenceKey, '1', 'EX', 120, 'NX');
      if (set === 'OK') {
        // Throttle gate opened → write to PostgreSQL
        await query(
          `UPDATE users SET last_seen_at = NOW() WHERE user_id = $1`,
          [userId],
        );
      }
    } catch {
      // Presence is best-effort; ignore all errors silently.
    }
  });
}

// ─── Middleware ───────────────────────────────────────────────────────────────

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next(new AppError(401, 'UNAUTHORIZED', 'Missing access token.'));
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, getPublicKey(), {
      algorithms: ['RS256'],
    }) as AccessTokenPayload;

    const user = await queryOne<Pick<UserRow,
      'account_status' | 'is_active' | 'is_under_review' | 'call_restriction_until'
    >>(
      `SELECT user_id, account_status, is_active, is_under_review, call_restriction_until
         FROM users
        WHERE user_id = $1`,
      [payload.sub],
    );
    if (!user) {
      return next(new AppError(401, 'USER_INACTIVE', 'Account not found or inactive.'));
    }
    assertCanAuthenticate(user);

    req.user = payload;

    // Async presence update — fire-and-forget, never awaited
    touchPresence(payload.sub);

    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return next(new AppError(401, 'TOKEN_EXPIRED', 'Access token expired.'));
    }
    return next(new AppError(401, 'INVALID_TOKEN', 'Invalid access token.'));
  }
}

/**
 * requireAdmin — verifies a shared secret from the x-admin-key header.
 * Used for internal admin endpoints (ML feedback, review resolution).
 * NOT a user-facing route — never returns JWT-specific errors.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const key = req.headers['x-admin-key'];
  const adminKey = process.env.ADMIN_API_KEY;

  if (!adminKey) {
    return next(new AppError(503, 'ADMIN_NOT_CONFIGURED', 'Admin key not configured.'));
  }
  if (!key || !adminKey) {
    return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Admin access denied.' } });
  }
  const keyBuf = Buffer.from(key as string);
  const adminBuf = Buffer.from(adminKey);
  if (keyBuf.length !== adminBuf.length || !crypto.timingSafeEqual(keyBuf, adminBuf)) {
    return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Admin access denied.' } });
  }
  next();
}
