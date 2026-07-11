import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import {
  createDisposableShare,
  getPermanentQrPayload,
  getShareDetail,
  listShares,
  resolveDeepLink,
  resolveShareToken,
  revokeShare,
} from '../services/contactShares';

export const sharesRouter = Router();

sharesRouter.get('/qr', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await getPermanentQrPayload(req.user!.sub);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  label: z.string().max(80).optional(),
  expires_at: z.string().datetime().optional(),
  expiry_hours: z.union([z.literal(24), z.literal(168), z.literal(720)]).optional(),
  max_uses: z.union([z.literal(1), z.literal(5), z.null()]).optional(),
});

sharesRouter.post('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = createSchema.parse(req.body ?? {});
    let expiresAt = body.expires_at;
    if (!expiresAt && body.expiry_hours) {
      expiresAt = new Date(Date.now() + body.expiry_hours * 3600_000).toISOString();
    }
    const data = await createDisposableShare(req.user!.sub, {
      label: body.label,
      expires_at: expiresAt,
      max_uses: body.max_uses === undefined ? null : body.max_uses,
    });
    res.status(201).json({ ok: true, data });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0]!.message));
    }
    next(err);
  }
});

sharesRouter.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await listShares(req.user!.sub);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

const linkSchema = z.object({ url: z.string().min(8).max(2000) });

sharesRouter.post('/links/resolve', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url } = linkSchema.parse(req.body);
    const deviceHash = typeof req.body?.device_hash === 'string' ? req.body.device_hash : undefined;
    const data = await resolveDeepLink(url, req.user!.sub, deviceHash);
    res.json({ ok: true, data });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0]!.message));
    }
    next(err);
  }
});

sharesRouter.post('/:token/resolve', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deviceHash = typeof req.body?.device_hash === 'string' ? req.body.device_hash : undefined;
    const data = await resolveShareToken(req.params.token!, req.user!.sub, deviceHash);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

sharesRouter.get('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await getShareDetail(req.user!.sub, req.params.id!);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

sharesRouter.delete('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await revokeShare(req.user!.sub, req.params.id!);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});
