import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import {
  getWalletSummary,
  getWalletPacks,
  listWalletTransactions,
  getWalletTransaction,
  getAutoRechargeSettings,
  updateAutoRecharge,
} from '../services/wallet';
import { createTopUpOrder } from '../services/razorpay';

export const walletRouter = Router();
walletRouter.use(requireAuth);

walletRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await getWalletSummary(req.user!.sub);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

walletRouter.get('/packs', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ ok: true, data: getWalletPacks() });
  } catch (err) {
    next(err);
  }
});

walletRouter.get('/transactions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? '40'), 10) || 40, 100);
    const offset = parseInt(String(req.query.offset ?? '0'), 10) || 0;
    const filter = typeof req.query.filter === 'string' ? req.query.filter : 'all';
    const data = await listWalletTransactions(req.user!.sub, limit, offset, filter);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

walletRouter.get('/transactions/:txn_id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await getWalletTransaction(req.user!.sub, req.params.txn_id!);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

walletRouter.get('/auto-recharge', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await getAutoRechargeSettings(req.user!.sub);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

const autoRechargeSchema = z.object({
  enabled: z.boolean(),
  pack_id: z.string().min(1).optional(),
  threshold_paise: z.number().int().min(1000).optional(),
});

walletRouter.patch('/auto-recharge', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = autoRechargeSchema.parse(req.body);
    const data = await updateAutoRecharge(req.user!.sub, body);
    res.json({ ok: true, data });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0]!.message));
    }
    next(err);
  }
});

const topupSchema = z.object({ pack_id: z.string().min(1) });

walletRouter.post('/topup', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { pack_id } = topupSchema.parse(req.body);
    const data = await createTopUpOrder(req.user!.sub, pack_id);
    res.json({ ok: true, data });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0]!.message));
    }
    next(err);
  }
});
