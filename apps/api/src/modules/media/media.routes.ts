/**
 * Media routes (all authenticated). Presign → client PUTs to S3 → confirm.
 */
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, validate, requireAuth, apiLimiter } from '@trustroute/core';
import { presignBody, mediaRefParam } from './media.schema';
import * as media from './media.service';

const router = Router();
router.use(requireAuth);

router.post(
  '/presign',
  validate({ body: presignBody }),
  asyncHandler(async (req, res) => {
    sendOk(res, await media.presign(req.user!.sub, req.valid.body as Parameters<typeof media.presign>[1]), {
      status: 201,
    });
  }),
);

router.post(
  '/:mediaRef/confirm',
  validate({ params: mediaRefParam }),
  asyncHandler(async (req, res) => {
    const { mediaRef } = req.valid.params as { mediaRef: string };
    sendOk(res, await media.confirm(req.user!.sub, mediaRef));
  }),
);

router.get(
  '/:mediaRef',
  validate({ params: mediaRefParam }),
  asyncHandler(async (req, res) => {
    const { mediaRef } = req.valid.params as { mediaRef: string };
    sendOk(res, await media.get(req.user!.sub, mediaRef));
  }),
);

router.delete(
  '/:mediaRef',
  validate({ params: mediaRefParam }),
  asyncHandler(async (req, res) => {
    const { mediaRef } = req.valid.params as { mediaRef: string };
    sendOk(res, await media.remove(req.user!.sub, mediaRef));
  }),
);

export function register(app: Express): void {
  app.use('/media', apiLimiter, router);
}
