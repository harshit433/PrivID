/**
 * `requireBusiness` — API-key auth for business-operator endpoints. Resolves the
 * `x-api-key` header to a verified business and attaches it as `req.business`.
 */
import type { Request, Response, NextFunction } from 'express';
import { appError } from '@trustroute/core';
import * as service from './business.service';
import type { BusinessRow } from './business.repository';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      business?: BusinessRow;
    }
  }
}

export async function requireBusiness(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const key = req.header('x-api-key');
    if (!key) throw appError('UNAUTHORIZED', 'API key required.');
    req.business = await service.authenticateApiKey(key);
    next();
  } catch (err) {
    next(err);
  }
}
