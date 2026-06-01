import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { AccessTokenPayload } from '@trustroute/shared';
import { AppError } from './errorHandler';

let publicKey: string | null = null;

function getPublicKey(): string {
  if (!publicKey) {
    // Prefer base64-encoded env var (Railway/cloud) over file path
    if (process.env.JWT_PUBLIC_KEY_B64) {
      publicKey = Buffer.from(process.env.JWT_PUBLIC_KEY_B64, 'base64').toString('utf8');
    } else {
      const keyPath = process.env.JWT_PUBLIC_KEY_PATH ?? './keys/public.pem';
      publicKey = fs.readFileSync(path.resolve(keyPath), 'utf8');
    }
  }
  return publicKey;
}

declare global {
  namespace Express {
    interface Request {
      user?: AccessTokenPayload;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next(new AppError(401, 'UNAUTHORIZED', 'Missing access token.'));
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, getPublicKey(), {
      algorithms: ['RS256'],
    }) as AccessTokenPayload;
    req.user = payload;
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return next(new AppError(401, 'TOKEN_EXPIRED', 'Access token expired.'));
    }
    return next(new AppError(401, 'INVALID_TOKEN', 'Invalid access token.'));
  }
}
