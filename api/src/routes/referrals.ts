import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import {
  getReferralHome,
  getReferralSummary,
  listMyReferrals,
  getReferralWallet,
  convertToCallBalance,
  validateReferralCode,
} from '../services/referrals';

export const referralsRouter = Router();

referralsRouter.get('/me', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await getReferralSummary(req.user!.sub);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

referralsRouter.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await listMyReferrals(req.user!.sub);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

referralsRouter.get('/wallet', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await getReferralWallet(req.user!.sub);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

const convertSchema = z.object({ amount_paise: z.number().int().positive() });

referralsRouter.post('/wallet/convert', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { amount_paise } = convertSchema.parse(req.body);
    await convertToCallBalance(req.user!.sub, amount_paise);
    const data = await getReferralHome(req.user!.sub);
    res.json({ ok: true, data });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0]!.message));
    }
    next(err);
  }
});

const validateSchema = z.object({ code: z.string().min(1).max(32) });

referralsRouter.post('/validate', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = validateSchema.parse(req.body);
    const result = await validateReferralCode(code, req.user!.sub);
    res.json({ ok: true, data: result });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0]!.message));
    }
    next(err);
  }
});
