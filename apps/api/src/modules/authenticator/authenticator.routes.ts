/**
 * Authenticator cloud-backup routes (all authenticated). The client encrypts the
 * vault on-device; here we only persist / return the opaque ciphertext keyed to the
 * user's durable identity.
 */
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, validate, requireAuth, apiLimiter } from '@trustroute/core';
import { putBackupBody } from './authenticator.schema';
import * as svc from './authenticator.service';

const router = Router();
router.use(requireAuth);

router.get(
  '/backup',
  asyncHandler(async (req, res) => {
    sendOk(res, await svc.getBackup(req.user!.sub));
  }),
);

router.put(
  '/backup',
  validate({ body: putBackupBody }),
  asyncHandler(async (req, res) => {
    sendOk(
      res,
      await svc.putBackup(req.user!.sub, req.valid.body as Parameters<typeof svc.putBackup>[1]),
    );
  }),
);

router.delete(
  '/backup',
  asyncHandler(async (req, res) => {
    sendOk(res, await svc.deleteBackup(req.user!.sub));
  }),
);

export function register(app: Express): void {
  app.use('/authenticator', apiLimiter, router);
}
