import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { query, queryOne } from '@trustroute/shared';
import { AppError } from '../middleware/errorHandler';

export const registerRouter = Router();

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
      const dup = await queryOne<{ business_id: string }>(
        `SELECT business_id FROM businesses WHERE gstin = $1 AND status NOT IN ('rejected')`,
        [gstin],
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
