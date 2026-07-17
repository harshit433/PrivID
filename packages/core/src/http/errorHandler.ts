/**
 * Terminal error middleware. Normalizes AppError, ZodError, and unknown throwables
 * into the failure envelope, always echoing the requestId. Unknown errors are
 * logged with their stack; their message is never leaked to the client.
 */
import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from './errors';
import type { ApiErr } from './envelope';
import { logger } from '../logger';

function fail(res: Response, status: number, body: ApiErr): void {
  res.status(status).json(body);
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestId = req.requestId;

  if (err instanceof AppError) {
    fail(res, err.statusCode, {
      ok: false,
      error: { code: err.code, message: err.message, requestId, ...(err.details ? { details: err.details } : {}) },
    });
    return;
  }

  if (err instanceof ZodError) {
    const first = err.issues[0];
    fail(res, 400, {
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Validation failed.',
        requestId,
        details: { issues: err.issues },
      },
    });
    return;
  }

  const error = err instanceof Error ? err : new Error(String(err));
  logger.error('http', 'unhandled error', { requestId, message: error.message, stack: error.stack });
  fail(res, 500, {
    ok: false,
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.', requestId },
  });
}

/** 404 fallback for unmatched routes — mount just before errorHandler. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    ok: false,
    error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}`, requestId: req.requestId },
  } satisfies ApiErr);
}
