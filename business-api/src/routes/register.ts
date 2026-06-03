import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { query, queryOne } from '@trustroute/shared';
import { AppError } from '../middleware/errorHandler';
import { validateGstin } from '../utils/gstin';

export const registerRouter = Router();

const uuidSchema = z.string().uuid();

const registerSchema = z.object({
  name: z.string().min(2).max(200),
  category: z.string().min(2).max(80),
  contact_email: z.string().email(),
  gstin: z.string().max(15).optional(),
  cin: z.string().max(21).optional(),
  website: z.string().url().optional().or(z.literal('')),
});

registerRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = registerSchema.parse(req.body);
    const gstin = body.gstin?.trim().toUpperCase() || null;
    const cin = body.cin?.trim().toUpperCase() || null;
    const website = body.website?.trim() || null;

    if (gstin) {
      const check = validateGstin(gstin);
      if (!check.valid) {
        throw new AppError(400, 'INVALID_GSTIN', check.reason ?? 'Invalid GSTIN.');
      }
      const dup = await queryOne<{ business_id: string }>(
        `SELECT business_id FROM businesses WHERE gstin = $1 AND status NOT IN ('rejected')`,
        [check.normalized],
      );
      if (dup) throw new AppError(409, 'GSTIN_EXISTS', 'A business with this GSTIN is already registered.');
    }

    const [row] = await query<{ business_id: string; status: string }>(
      `INSERT INTO businesses (name, category, contact_email, gstin, cin, website, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING business_id, status::text AS status`,
      [body.name.trim(), body.category.trim(), body.contact_email.trim().toLowerCase(), gstin, cin, website],
    );

    res.status(201).json({
      ok: true,
      data: { business_id: row.business_id, status: row.status },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    }
    next(err);
  }
});

/** Public — poll onboarding status before API key is issued. */
registerRouter.get('/status/:businessId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const businessId = uuidSchema.parse(req.params.businessId);
    const row = await queryOne<{
      business_id: string;
      status: string;
      rejection_reason: string | null;
      verified_at: Date | null;
      name: string;
    }>(
      `SELECT business_id, status::text AS status, rejection_reason, verified_at, name
       FROM businesses WHERE business_id = $1`,
      [businessId],
    );
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Registration not found.');
    res.json({ ok: true, data: row });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', 'Invalid business id.'));
    }
    next(err);
  }
});

registerRouter.post('/validate-gstin', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { gstin } = z.object({ gstin: z.string().min(1).max(15) }).parse(req.body);
    const result = validateGstin(gstin);
    if (!result.valid) {
      return res.json({ ok: true, data: { valid: false, reason: result.reason } });
    }
    const dup = await queryOne<{ business_id: string }>(
      `SELECT business_id FROM businesses WHERE gstin = $1 AND status NOT IN ('rejected')`,
      [result.normalized],
    );
    if (dup) {
      return res.json({ ok: true, data: { valid: false, reason: 'This GSTIN is already registered.' } });
    }
    res.json({ ok: true, data: { valid: true, normalized: result.normalized } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    }
    next(err);
  }
});
