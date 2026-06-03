import { Request, Response, NextFunction } from 'express';
import { queryOne, hashApiKey } from '@trustroute/shared';
import { AppError } from './errorHandler';

export type BusinessAuth = {
  business_id: string;
  name: string;
  plan: 'starter' | 'growth' | 'enterprise';
  status: string;
};

declare global {
  namespace Express {
    interface Request {
      business?: BusinessAuth;
    }
  }
}

export async function requireApiKey(req: Request, _res: Response, next: NextFunction) {
  const raw = req.headers['x-api-key'];
  if (!raw || typeof raw !== 'string' || raw.length < 16) {
    return next(new AppError(401, 'UNAUTHORIZED', 'Missing or invalid x-api-key header.'));
  }

  const keyHash = hashApiKey(raw.trim());
  try {
    const row = await queryOne<BusinessAuth>(
      `SELECT business_id, name, plan::text AS plan, status::text AS status
       FROM businesses
       WHERE api_key_hash = $1 AND status = 'verified'`,
      [keyHash],
    );
    if (!row) {
      return next(new AppError(401, 'INVALID_API_KEY', 'API key is invalid or business is not verified.'));
    }
    req.business = row;
    next();
  } catch (err) {
    next(err);
  }
}
