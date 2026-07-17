/**
 * Zod request validation. Parses body/query/params and stashes the typed result on
 * `req.valid`. Parse failures throw ZodError which the error handler renders as a
 * 400 VALIDATION_ERROR. Route handlers read `req.valid.body` etc. with the schema's
 * inferred type.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { ZodTypeAny, infer as ZInfer } from 'zod';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      valid: { body: unknown; query: unknown; params: unknown };
    }
  }
}

interface Schemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

export function validate(schemas: Schemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.valid = {
        body: schemas.body ? schemas.body.parse(req.body ?? {}) : req.body,
        query: schemas.query ? schemas.query.parse(req.query ?? {}) : req.query,
        params: schemas.params ? schemas.params.parse(req.params ?? {}) : req.params,
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Typed accessors — keep handlers terse and correctly typed. */
export function body<S extends ZodTypeAny>(req: Request, _schema: S): ZInfer<S> {
  return req.valid.body as ZInfer<S>;
}
export function queryOf<S extends ZodTypeAny>(req: Request, _schema: S): ZInfer<S> {
  return req.valid.query as ZInfer<S>;
}
export function paramsOf<S extends ZodTypeAny>(req: Request, _schema: S): ZInfer<S> {
  return req.valid.params as ZInfer<S>;
}
