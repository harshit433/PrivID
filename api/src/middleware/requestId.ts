import { randomUUID } from 'crypto';
import { Request, Response, NextFunction } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

/** Attach a correlation id to every request/response for support and logging. */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const id = incoming && incoming.length <= 64 ? incoming : randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}
