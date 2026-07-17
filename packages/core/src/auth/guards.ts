/**
 * Express auth guards.
 *
 * `requireAuth` verifies the RS256 JWT, then confirms the account may still hold a
 * session and (fire-and-forget) touches presence. The user-load and presence-touch
 * steps are injected via `configureAuth` so `core` stays decoupled from the schema
 * (wired once at API boot from the users module).
 */
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, jwt, type AccessTokenPayload } from './jwt';
import { assertCanAuthenticate, type AccountStatus } from './accountState';
import { appError } from '../http/errors';
import { config } from '../config';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AccessTokenPayload;
    }
  }
}

export interface AuthAccountRow {
  userId: string;
  accountStatus: AccountStatus;
  isActive: boolean;
}

type UserLoader = (userId: string) => Promise<AuthAccountRow | null>;
type PresenceToucher = (userId: string) => void;

let userLoader: UserLoader | null = null;
let presenceToucher: PresenceToucher | null = null;

/** Wire the DB-backed hooks the guard needs. Call once at API startup. */
export function configureAuth(opts: { loadUser: UserLoader; touchPresence?: PresenceToucher }): void {
  userLoader = opts.loadUser;
  presenceToucher = opts.touchPresence ?? null;
}

function bearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7);
}

async function authenticate(req: Request): Promise<AccessTokenPayload> {
  const token = bearer(req);
  if (!token) throw appError('UNAUTHORIZED', 'Missing access token.');

  let payload: AccessTokenPayload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw appError('TOKEN_EXPIRED');
    throw appError('INVALID_TOKEN');
  }

  if (!userLoader) throw appError('SERVICE_UNAVAILABLE', 'Auth is not initialised.');
  const account = await userLoader(payload.sub);
  if (!account) throw appError('USER_INACTIVE');
  assertCanAuthenticate(account);

  req.user = payload;
  presenceToucher?.(payload.sub);
  return payload;
}

/** Reject unauthenticated requests. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    await authenticate(req);
    next();
  } catch (err) {
    next(err);
  }
}

/** Attach req.user when a valid token is present; never rejects. */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    if (bearer(req)) await authenticate(req);
  } catch {
    // ignore — optional
  }
  next();
}

/** Shared-secret admin guard (x-admin-key), timing-safe. */
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  const provided = req.headers['x-admin-key'];
  const adminKey = config.ADMIN_API_KEY;
  if (!adminKey) return next(appError('NOT_CONFIGURED', 'Admin key not configured.'));
  if (typeof provided !== 'string') return next(appError('UNAUTHORIZED', 'Admin access denied.'));
  const a = Buffer.from(provided);
  const b = Buffer.from(adminKey);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return next(appError('UNAUTHORIZED', 'Admin access denied.'));
  }
  next();
}
