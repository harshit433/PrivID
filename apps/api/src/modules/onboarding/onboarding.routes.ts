/**
 * Onboarding routes — the public signup / recovery surface. No auth (the user has no
 * account yet); a session id threads the steps together and completion returns tokens.
 */
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, validate, publicLimiter } from '@trustroute/core';
import {
  startBody,
  sessionBody,
  digilockerCallbackBody,
  livenessCompleteBody,
  checkHandleBody,
  setHandleBody,
  completeBody,
} from './onboarding.schema';
import * as onboarding from './onboarding.service';
import { digilockerReturnRouter } from './digilocker.return';

const router = Router();

router.post(
  '/start',
  validate({ body: startBody }),
  asyncHandler(async (req, res) => {
    const b = req.valid.body as { purpose?: string; deviceFingerprintHash?: string; integrity?: Record<string, unknown> };
    sendOk(res, await onboarding.start(b), { status: 201 });
  }),
);

router.post(
  '/digilocker/start',
  validate({ body: sessionBody }),
  asyncHandler(async (req, res) => {
    const { sessionId } = req.valid.body as { sessionId: string };
    sendOk(res, await onboarding.digilockerStart(sessionId));
  }),
);

router.post(
  '/digilocker/callback',
  validate({ body: digilockerCallbackBody }),
  asyncHandler(async (req, res) => {
    const { sessionId } = req.valid.body as { sessionId: string };
    sendOk(res, await onboarding.digilockerCallback(sessionId));
  }),
);

router.post(
  '/liveness/start',
  validate({ body: sessionBody }),
  asyncHandler(async (req, res) => {
    const { sessionId } = req.valid.body as { sessionId: string };
    sendOk(res, await onboarding.livenessStart(sessionId));
  }),
);

router.post(
  '/liveness/complete',
  validate({ body: livenessCompleteBody }),
  asyncHandler(async (req, res) => {
    const { sessionId, selfieB64 } = req.valid.body as {
      sessionId: string;
      selfieB64: string;
    };
    sendOk(res, await onboarding.livenessComplete(sessionId, selfieB64));
  }),
);

router.post(
  '/match',
  validate({ body: sessionBody }),
  asyncHandler(async (req, res) => {
    const { sessionId } = req.valid.body as { sessionId: string };
    sendOk(res, await onboarding.match(sessionId));
  }),
);

router.post(
  '/handle/check',
  validate({ body: checkHandleBody }),
  asyncHandler(async (req, res) => {
    const { handle } = req.valid.body as { handle: string };
    sendOk(res, await onboarding.checkHandle(handle));
  }),
);

router.post(
  '/handle',
  validate({ body: setHandleBody }),
  asyncHandler(async (req, res) => {
    const { sessionId, handle, displayName } = req.valid.body as {
      sessionId: string;
      handle: string;
      displayName?: string;
    };
    sendOk(res, await onboarding.setHandle(sessionId, handle, displayName));
  }),
);

router.post(
  '/complete',
  validate({ body: completeBody }),
  asyncHandler(async (req, res) => {
    const { sessionId, pin } = req.valid.body as { sessionId: string; pin?: string };
    sendOk(res, await onboarding.complete(sessionId, pin), { status: 201 });
  }),
);

export function register(app: Express): void {
  app.use('/onboarding/digilocker', digilockerReturnRouter);
  app.use('/onboarding', publicLimiter, router);
}
