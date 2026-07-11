import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import {
  maskedPrecheck,
  initiateMaskedCall,
  getMaskedCall,
} from '../services/maskedCalling';

export const maskedRouter = Router();
maskedRouter.use(requireAuth);

const numberSchema = z.object({
  number: z.string().min(8).max(20),
});

maskedRouter.post('/precheck', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { number } = numberSchema.parse(req.body);
    const data = await maskedPrecheck(req.user!.sub, number);
    res.json({ ok: true, data });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0]!.message));
    }
    next(err);
  }
});

maskedRouter.post('/call', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { number } = numberSchema.parse(req.body);
    const base =
      process.env.API_BASE_URL ??
      (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${process.env.PORT ?? 3000}`);
    const data = await initiateMaskedCall(req.user!.sub, number, base);
    res.json({ ok: true, data });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0]!.message));
    }
    next(err);
  }
});

maskedRouter.get('/calls/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await getMaskedCall(req.params.id!, req.user!.sub);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});
