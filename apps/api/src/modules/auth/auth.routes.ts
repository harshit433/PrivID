/**
 * Auth routes. Public sign-in surface (check-handle / login / refresh) plus
 * authenticated logout + set-PIN. Legacy OTP/register endpoints are gone → 410.
 */
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, validate, requireAuth, publicLimiter, appError } from '@trustroute/core';
import { checkHandleBody, loginBody, refreshBody, setPinBody } from './auth.schema';
import * as authService from './auth.service';

const router = Router();

const LEGACY = new Set([
  'POST /register/initiate',
  'POST /register/verify',
  'POST /login/initiate',
  'POST /login/verify',
  'POST /otp/send',
  'POST /otp/verify',
  'POST /otp/resend',
  'POST /phone/check',
]);

router.use((req, _res, next) => {
  if (LEGACY.has(`${req.method} ${req.path}`)) {
    return next(appError('LEGACY_AUTH_DISABLED'));
  }
  next();
});

router.post(
  '/check-handle',
  validate({ body: checkHandleBody }),
  asyncHandler(async (req, res) => {
    const { handle } = req.valid.body as { handle: string };
    sendOk(res, await authService.checkHandle(handle));
  }),
);

router.post(
  '/login',
  validate({ body: loginBody }),
  asyncHandler(async (req, res) => {
    const { handle, pin, deviceId } = req.valid.body as { handle: string; pin: string; deviceId?: string };
    sendOk(res, await authService.loginWithPin(handle, pin, deviceId));
  }),
);

router.post(
  '/refresh',
  validate({ body: refreshBody }),
  asyncHandler(async (req, res) => {
    const { refresh_token } = req.valid.body as { refresh_token: string };
    sendOk(res, await authService.refresh(refresh_token));
  }),
);

router.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    await authService.logout(req.user!.sub);
    sendOk(res, { loggedOut: true });
  }),
);

router.post(
  '/pin',
  requireAuth,
  validate({ body: setPinBody }),
  asyncHandler(async (req, res) => {
    const { pin } = req.valid.body as { pin: string };
    await authService.setUserPin(req.user!.sub, pin);
    sendOk(res, { pinSet: true });
  }),
);

export function register(app: Express): void {
  app.use('/auth', publicLimiter, router);
}
