import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { submitUserReport } from '../services/userReports';

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

const reportSchema = z.object({
  reported_user_id: z.string().uuid().optional(),
  reported_number: z.string().min(8).max(20).optional(),
  reason_type: z.enum(['spam_scam', 'harassment', 'impersonation', 'inappropriate', 'other']),
  note: z.string().max(1000).optional(),
  context_type: z.enum(['call', 'chat', 'contact', 'profile', 'number', 'business']).optional(),
  context_id: z.string().max(120).optional(),
  block_also: z.boolean().optional(),
}).refine((v) => v.reported_user_id || v.reported_number, {
  message: 'Provide reported_user_id or reported_number.',
});

reportsRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = reportSchema.parse(req.body);
    const result = await submitUserReport({
      reporterId: req.user!.sub,
      reportedUserId: body.reported_user_id,
      reportedNumberE164: body.reported_number,
      reasonType: body.reason_type,
      note: body.note,
      contextType: body.context_type,
      contextId: body.context_id,
      blockAlso: body.block_also,
    });
    res.status(201).json({
      ok: true,
      data: {
        report_id: result.report_id,
        message: 'Thanks — we\'ll review this.',
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    }
    next(err);
  }
});

const numberReportSchema = z.object({
  phone_number: z.string().min(8).max(20),
  reason_type: z.enum(['spam_scam', 'harassment', 'impersonation', 'inappropriate', 'other']),
  note: z.string().max(1000).optional(),
});

/** RPT-02 — signed-in user reports an off-network / masked number. */
reportsRouter.post('/number', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = numberReportSchema.parse(req.body);
    const normalized = body.phone_number.replace(/\s+/g, '');
    const result = await submitUserReport({
      reporterId: req.user!.sub,
      reportedNumberE164: normalized.startsWith('+') ? normalized : `+${normalized}`,
      reasonType: body.reason_type,
      note: body.note,
      contextType: 'number',
      contextId: normalized,
    });
    res.status(201).json({
      ok: true,
      data: {
        report_id: result.report_id,
        message: 'Thanks — we\'ll review this number.',
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    }
    next(err);
  }
});
