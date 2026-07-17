/**
 * Uniform response envelope. Every endpoint returns one of these shapes so the
 * mobile client has exactly one unwrapper and one error path.
 *
 *   success: { ok: true, data, meta? }
 *   failure: { ok: false, error: { code, message, requestId?, details? } }
 *
 * `meta` carries cursor pagination for list endpoints.
 */
import type { Response } from 'express';
import { toSnakeCaseDeep } from './caseTransform';

export interface PageMeta {
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ApiOk<T> {
  ok: true;
  data: T;
  meta?: PageMeta;
}

export interface ApiErr {
  ok: false;
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: Record<string, unknown>;
  };
}

export type ApiResponse<T> = ApiOk<T> | ApiErr;

export function ok<T>(data: T, meta?: PageMeta): ApiOk<T> {
  return meta ? { ok: true, data, meta } : { ok: true, data };
}

/**
 * Send a success envelope. Use `status` for 201/202 etc.; defaults to 200. The payload
 * (and meta) is snake_cased at the boundary so the mobile client's contract is stable.
 */
export function sendOk<T>(res: Response, data: T, opts?: { status?: number; meta?: PageMeta }): void {
  const meta = opts?.meta ? (toSnakeCaseDeep(opts.meta) as PageMeta) : undefined;
  res.status(opts?.status ?? 200).json(ok(toSnakeCaseDeep(data), meta));
}

/** Send a paginated list. */
export function sendPage<T>(res: Response, items: T[], meta: PageMeta): void {
  res.status(200).json(ok(toSnakeCaseDeep(items), toSnakeCaseDeep(meta) as PageMeta));
}
