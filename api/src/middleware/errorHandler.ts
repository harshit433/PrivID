import { Request, Response, NextFunction } from 'express';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        requestId: _req.requestId,
        ...(err.details ? { details: err.details } : {}),
      },
    });
  }

  console.error('[Unhandled Error]', err, { requestId: _req.requestId });
  return res.status(500).json({
    ok: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong.',
      requestId: _req.requestId,
    },
  });
}
