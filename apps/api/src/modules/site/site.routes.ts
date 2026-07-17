/**
 * Site routes — public, unauthenticated marketing forms (tight public rate limit).
 */
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, validate, publicLimiter } from '@trustroute/core';
import { z } from 'zod';
import * as site from './site.service';

const contactBody = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254),
  message: z.string().trim().min(1).max(4000),
  source: z.string().trim().max(80).optional(),
  page: z.string().trim().max(200).optional(),
});

const waitlistBody = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254),
  interestLevel: z.coerce.number().int().min(1).max(5),
  whyBetter: z.string().trim().min(1).max(2000),
  whyWilling: z.string().trim().min(1).max(2000),
  source: z.string().trim().max(80).optional(),
  page: z.string().trim().max(200).optional(),
});

const router = Router();

router.post(
  '/contact',
  validate({ body: contactBody }),
  asyncHandler(async (req, res) => {
    sendOk(res, await site.contact(req.valid.body as Parameters<typeof site.contact>[0], { ip: req.ip, userAgent: req.header('user-agent') ?? undefined }), { status: 201 });
  }),
);

router.post(
  '/waitlist',
  validate({ body: waitlistBody }),
  asyncHandler(async (req, res) => {
    sendOk(res, await site.waitlist(req.valid.body as Parameters<typeof site.waitlist>[0], { ip: req.ip, userAgent: req.header('user-agent') ?? undefined }), { status: 201 });
  }),
);

export function register(app: Express): void {
  app.use('/site', publicLimiter, router);
}
