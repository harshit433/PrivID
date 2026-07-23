/**
 * Onboarding routes — the public signup / recovery surface. No auth (the user has no
 * account yet); a session id threads the steps together and completion returns tokens.
 */
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, validate, publicLimiter, requireAuth } from '@trustroute/core';
import {
  startBody,
  sessionBody,
  digilockerCallbackBody,
  livenessCompleteBody,
  sessionHandleCheckBody,
  handleCheckQuery,
  sessionIdQuery,
  setHandleBody,
  completeBody,
  finishBody,
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
  validate({ body: sessionHandleCheckBody }),
  asyncHandler(async (req, res) => {
    const { sessionId, handle } = req.valid.body as { sessionId: string; handle: string };
    sendOk(res, await onboarding.checkHandleForSession(sessionId, handle));
  }),
);

router.get(
  '/handle/check',
  validate({ query: handleCheckQuery }),
  asyncHandler(async (req, res) => {
    const { session_id: sessionId, handle } = req.valid.query as {
      session_id: string;
      handle: string;
    };
    sendOk(res, await onboarding.checkHandleForSession(sessionId, handle));
  }),
);

router.get(
  '/handle/suggest',
  validate({ query: sessionIdQuery }),
  asyncHandler(async (req, res) => {
    const { session_id: sessionId } = req.valid.query as { session_id: string };
    sendOk(res, await onboarding.suggestHandles(sessionId));
  }),
);

router.post(
  '/handle/suggest',
  validate({ body: sessionBody }),
  asyncHandler(async (req, res) => {
    const { sessionId } = req.valid.body as { sessionId: string };
    sendOk(res, await onboarding.suggestHandles(sessionId));
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
    const { sessionId, pin, displayName } = req.valid.body as {
      sessionId: string;
      pin?: string;
      displayName?: string;
    };
    sendOk(res, await onboarding.complete(sessionId, pin, displayName), { status: 201 });
  }),
);

// Authenticated, unlike the rest of this router: by this point `/complete` has
// already minted tokens, and we need to know which account to finish.
router.post(
  '/finish',
  requireAuth,
  validate({ body: finishBody }),
  asyncHandler(async (req, res) => {
    const { referralCode } = req.valid.body as { referralCode?: string };
    sendOk(res, await onboarding.finish(req.user!.sub, referralCode));
  }),
);

export function register(app: Express): void {
  app.use('/onboarding/digilocker', digilockerReturnRouter);
  app.use('/onboarding', publicLimiter, router);
}
