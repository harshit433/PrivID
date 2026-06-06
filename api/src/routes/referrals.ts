import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import {
  getReferralSummary,
  requestWithdrawal,
  validateReferralCode,
} from '../services/referrals';

export const referralsRouter = Router();

// ─── GET /referrals/me ────────────────────────────────────────────────────────

referralsRouter.get('/me', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await getReferralSummary(req.user!.sub);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

// ─── POST /referrals/validate ─────────────────────────────────────────────────

const validateSchema = z.object({
  code: z.string().min(1).max(32),
});

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

// ─── POST /referrals/withdraw ─────────────────────────────────────────────────

const withdrawSchema = z.object({
  amount_paise: z.number().int().positive(),
  upi_id: z.string().min(3).max(100),
});

referralsRouter.post('/withdraw', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = withdrawSchema.parse(req.body);
    const data = await requestWithdrawal(req.user!.sub, body.amount_paise, body.upi_id);
    res.json({ ok: true, data });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0]!.message));
    }
    next(err);
  }
});
