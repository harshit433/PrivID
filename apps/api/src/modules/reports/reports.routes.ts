/**
 * Reports routes (all authenticated).
 */
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, validate, requireAuth, apiLimiter } from '@trustroute/core';
import { fileBody, numberBody } from './reports.schema';
import * as reports from './reports.service';

const router = Router();
router.use(requireAuth);

router.get('/', asyncHandler(async (req, res) => sendOk(res, await reports.mine(req.user!.sub))));

router.post(
  '/',
  validate({ body: fileBody }),
  asyncHandler(async (req, res) => {
    sendOk(res, await reports.file(req.user!.sub, req.valid.body as Parameters<typeof reports.file>[1]), { status: 201 });
  }),
);

/**
 * Reporting a number rather than a handle. The generic POST / already accepts
 * `reportedNumber`; this is the surface the app calls when the subject is a
 * PSTN number it met through masked calling, and it defaults the context
 * accordingly.
 */
router.post(
  '/number',
  validate({ body: numberBody }),
  asyncHandler(async (req, res) => {
    const b = req.valid.body as {
      phoneNumber?: string;
      reportedNumber?: string;
      reason?: Parameters<typeof reports.file>[1]['reasonType'];
      reasonType?: Parameters<typeof reports.file>[1]['reasonType'];
      note?: string;
      contextType?: Parameters<typeof reports.file>[1]['contextType'];
      contextId?: string;
    };
    sendOk(
      res,
      await reports.file(req.user!.sub, {
        reportedNumber: b.reportedNumber ?? b.phoneNumber,
        reasonType: (b.reasonType ?? b.reason)!,
        note: b.note,
        contextType: b.contextType ?? 'number',
        contextId: b.contextId,
      }),
      { status: 201 },
    );
  }),
);

export function register(app: Express): void {
  app.use('/reports', apiLimiter, router);
}
