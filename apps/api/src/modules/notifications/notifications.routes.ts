/**
 * Notifications routes (all authenticated): register/list/remove devices + a self-test.
 */
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, validate, requireAuth, apiLimiter } from '@trustroute/core';
import { z } from 'zod';
import * as notifications from './notifications.service';

const registerBody = z.object({
  platform: z.enum(['ios', 'android']),
  hardwareId: z.string().trim().min(1).max(200),
  pushToken: z.string().trim().max(512).optional(),
  deviceFingerprint: z.string().trim().max(256).optional(),
  devicePubKey: z.string().trim().max(2048).optional(),
});
const deviceIdParam = z.object({ deviceId: z.string().uuid() });

const router = Router();
router.use(requireAuth);

router.get('/devices', asyncHandler(async (req, res) => sendOk(res, await notifications.listDevices(req.user!.sub))));

router.post(
  '/devices',
  validate({ body: registerBody }),
  asyncHandler(async (req, res) => {
    sendOk(res, await notifications.registerDevice(req.user!.sub, req.valid.body as Parameters<typeof notifications.registerDevice>[1]), { status: 201 });
  }),
);

router.delete(
  '/devices/:deviceId',
  validate({ params: deviceIdParam }),
  asyncHandler(async (req, res) => {
    const { deviceId } = req.valid.params as { deviceId: string };
    sendOk(res, await notifications.unregister(req.user!.sub, deviceId));
  }),
);

router.post('/test', asyncHandler(async (req, res) => sendOk(res, await notifications.sendTest(req.user!.sub))));

export function register(app: Express): void {
  app.use('/notifications', apiLimiter, router);
}
