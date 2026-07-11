import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import {
  listPayoutMethods,
  addPayoutMethodUpi,
  addPayoutMethodBank,
  deletePayoutMethod,
} from '../services/payoutMethods';

export const payoutMethodsRouter = Router();
payoutMethodsRouter.use(requireAuth);

payoutMethodsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await listPayoutMethods(req.user!.sub);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

const upiSchema = z.object({ upi_id: z.string().min(3).max(100) });

payoutMethodsRouter.post('/upi', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { upi_id } = upiSchema.parse(req.body);
    const data = await addPayoutMethodUpi(req.user!.sub, upi_id);
    res.json({ ok: true, data });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0]!.message));
    }
    next(err);
  }
});

const bankSchema = z.object({
  account_number: z.string().min(8).max(20),
  ifsc: z.string().min(11).max(11),
  holder_name: z.string().min(2).max(100),
});

payoutMethodsRouter.post('/bank', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = bankSchema.parse(req.body);
    const data = await addPayoutMethodBank(req.user!.sub, body);
    res.json({ ok: true, data });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0]!.message));
    }
    next(err);
  }
});

payoutMethodsRouter.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await deletePayoutMethod(req.user!.sub, req.params.id!);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
