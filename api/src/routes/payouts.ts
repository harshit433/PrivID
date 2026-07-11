import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { requestPayout, listPayouts } from '../services/payouts';

export const payoutsRouter = Router();
payoutsRouter.use(requireAuth);

payoutsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await listPayouts(req.user!.sub);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

const payoutSchema = z.object({
  amount_paise: z.number().int().positive(),
  method_id: z.string().uuid(),
});

payoutsRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = payoutSchema.parse(req.body);
    const data = await requestPayout(req.user!.sub, body.amount_paise, body.method_id);
    res.json({ ok: true, data });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0]!.message));
    }
    next(err);
  }
});
