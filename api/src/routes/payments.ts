import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { query, queryOne } from '@trustroute/shared';
import { handleRazorpayWebhook, verifyRazorpayWebhookSignature } from '../services/razorpay';
import { handleRazorpayXWebhook, verifyRazorpayXWebhookSignature } from '../services/razorpayx';

export const paymentsRouter = Router();

paymentsRouter.post('/razorpay/webhook', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sig = req.headers['x-razorpay-signature'];
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!sig || typeof sig !== 'string' || !raw) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_SIGNATURE', message: 'Missing signature' } });
    }
    if (!verifyRazorpayWebhookSignature(raw, sig)) {
      return res.status(401).json({ ok: false, error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature' } });
    }
    await handleRazorpayWebhook(req.body);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

paymentsRouter.post('/razorpayx/webhook', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sig = req.headers['x-razorpay-signature'];
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!sig || typeof sig !== 'string' || !raw) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_SIGNATURE', message: 'Missing signature' } });
    }
    if (!verifyRazorpayXWebhookSignature(raw, sig)) {
      return res.status(401).json({ ok: false, error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature' } });
    }
    await handleRazorpayXWebhook(req.body);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export const telephonyRouter = Router();

telephonyRouter.post('/webhook', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { verifyTelephonyWebhook, getTelephonyProvider } = await import('../services/telephony');
    const { processTelephonyEvent } = await import('../services/maskedCalling');
    if (!verifyTelephonyWebhook(req)) {
      return res.status(401).json({ ok: false, error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature' } });
    }
    const provider = getTelephonyProvider();
    const event = provider.parseWebhook(req.body, String(req.headers['x-telephony-signature'] ?? ''));
    if (event) {
      await processTelephonyEvent(event);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export const privacySubscriptionRouter = Router();
privacySubscriptionRouter.use(requireAuth);

const PRIVACY_PACK_PRICE_PAISE = 14900;

privacySubscriptionRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sub = await queryOne(
      `SELECT plan, status, minutes_included, renews_at, razorpay_sub_id
       FROM privacy_subscriptions WHERE user_id = $1`,
      [req.user!.sub],
    );
    const data = sub ?? { status: 'none' };
    res.json({ ok: true, data: { ...data, price_paise: PRIVACY_PACK_PRICE_PAISE } });
  } catch (err) {
    next(err);
  }
});

const subscribeSchema = z.object({ plan: z.string().default('privacy_pack') });

privacySubscriptionRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { plan } = subscribeSchema.parse(req.body);
    await query(
      `INSERT INTO privacy_subscriptions (user_id, plan, status, minutes_included, renews_at)
       VALUES ($1, $2, 'active', 300, NOW() + INTERVAL '30 days')
       ON CONFLICT (user_id) DO UPDATE
         SET plan = EXCLUDED.plan, status = 'active',
             minutes_included = 300, renews_at = NOW() + INTERVAL '30 days', updated_at = NOW()`,
      [req.user!.sub, plan],
    );
    const sub = await queryOne(
      `SELECT plan, status, minutes_included, renews_at FROM privacy_subscriptions WHERE user_id = $1`,
      [req.user!.sub],
    );
    res.json({ ok: true, data: { ...sub, price_paise: PRIVACY_PACK_PRICE_PAISE } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0]!.message));
    }
    next(err);
  }
});

privacySubscriptionRouter.delete('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await query(
      `UPDATE privacy_subscriptions SET status = 'cancelled', updated_at = NOW() WHERE user_id = $1`,
      [req.user!.sub],
    );
    res.json({ ok: true, data: { status: 'cancelled' } });
  } catch (err) {
    next(err);
  }
});

export const publicReportRouter = Router();

publicReportRouter.get('/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { getLandingByToken } = await import('../services/maskedCalling');
    const data = await getLandingByToken(req.params.token!);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

const reportSchema = z.object({ reporter_hash: z.string().optional() });

publicReportRouter.post('/:token/report', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = reportSchema.parse(req.body ?? {});
    const { reportUnwantedCall } = await import('../services/maskedCalling');
    const data = await reportUnwantedCall(req.params.token!, body.reporter_hash);
    res.json({ ok: true, data });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0]!.message));
    }
    next(err);
  }
});
