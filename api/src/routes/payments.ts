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

privacySubscriptionRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { PRIVACY_PACK_PRICE_PAISE, isRazorpayConfigured } = await import('../services/razorpay');
    const sub = await queryOne(
      `SELECT plan, status, minutes_included, renews_at, razorpay_sub_id
       FROM privacy_subscriptions WHERE user_id = $1`,
      [req.user!.sub],
    );
    const data = sub ?? { status: 'none' };
    res.json({
      ok: true,
      data: {
        ...data,
        price_paise: PRIVACY_PACK_PRICE_PAISE,
        payments_available: isRazorpayConfigured(),
      },
    });
  } catch (err) {
    next(err);
  }
});

const subscribeSchema = z.object({ plan: z.string().default('privacy_pack') });

privacySubscriptionRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    subscribeSchema.parse(req.body);
    const { createPrivacyPackOrder, isRazorpayConfigured } = await import('../services/razorpay');
    if (!isRazorpayConfigured()) {
      throw new AppError(503, 'PAYMENTS_UNAVAILABLE', 'Payments are briefly unavailable.');
    }
    const order = await createPrivacyPackOrder(req.user!.sub);
    res.json({ ok: true, data: order });
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
