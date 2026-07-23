/**
 * Users routes. All authenticated (per-user rate limit). `/me*` operate on the caller;
 * `/discover` and `/:handle` read other users subject to their discovery settings.
 * Specific paths are declared before `/:handle` so `me`/`discover` aren't captured.
 */
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, validate, requireAuth, apiLimiter } from '@trustroute/core';
import {
  updateProfileBody,
  setAvatarBody,
  uploadAvatarBody,
  setStatusBody,
  updateSettingsBody,
  changeHandleBody,
  handleParam,
  discoverQuery,
  lookupByPhonesBody,
} from './users.schema';
import * as users from './users.service';
import * as business from '../business/business.service';

const router = Router();
router.use(requireAuth);

// ── Self ──────────────────────────────────────────────────────────────────────
router.get(
  '/me',
  asyncHandler(async (req, res) => {
    sendOk(res, await users.getMe(req.user!.sub));
  }),
);

router.patch(
  '/me',
  validate({ body: updateProfileBody }),
  asyncHandler(async (req, res) => {
    sendOk(res, await users.updateProfile(req.user!.sub, req.valid.body as Record<string, unknown>));
  }),
);

router.post(
  '/me/avatar',
  validate({ body: uploadAvatarBody }),
  asyncHandler(async (req, res) => {
    const { imageBase64, contentType } = req.valid.body as {
      imageBase64: string;
      contentType: 'image/jpeg' | 'image/png' | 'image/webp';
    };
    const profile = await users.uploadAvatarBase64(req.user!.sub, imageBase64, contentType);
    sendOk(res, profile);
  }),
);

router.put(
  '/me/avatar',
  validate({ body: setAvatarBody }),
  asyncHandler(async (req, res) => {
    const { avatarUrl } = req.valid.body as { avatarUrl: string | null };
    sendOk(res, await users.setAvatar(req.user!.sub, avatarUrl));
  }),
);

router.put(
  '/me/status',
  validate({ body: setStatusBody }),
  asyncHandler(async (req, res) => {
    const { statusText, statusEmoji } = req.valid.body as { statusText?: string | null; statusEmoji?: string | null };
    sendOk(res, await users.setStatus(req.user!.sub, statusText ?? null, statusEmoji ?? null));
  }),
);

router.get(
  '/me/settings',
  asyncHandler(async (req, res) => {
    sendOk(res, await users.getSettings(req.user!.sub));
  }),
);

router.patch(
  '/me/settings',
  validate({ body: updateSettingsBody }),
  asyncHandler(async (req, res) => {
    sendOk(res, await users.updateSettings(req.user!.sub, req.valid.body as Record<string, unknown>));
  }),
);

router.put(
  '/me/handle',
  validate({ body: changeHandleBody }),
  asyncHandler(async (req, res) => {
    const { handle } = req.valid.body as { handle: string };
    sendOk(res, await users.changeHandle(req.user!.sub, handle));
  }),
);

router.post(
  '/me/data-export',
  asyncHandler(async (req, res) => {
    sendOk(res, await users.requestDataExport(req.user!.sub), { status: 202 });
  }),
);

router.get(
  '/me/data-export',
  asyncHandler(async (req, res) => {
    sendOk(res, await users.listDataExports(req.user!.sub));
  }),
);

router.delete(
  '/me',
  asyncHandler(async (req, res) => {
    sendOk(res, await users.deleteAccount(req.user!.sub));
  }),
);

/**
 * Rotating counter QR for a user who owns a verified business. Placed with the
 * other /me routes so it is matched before `/:handle`.
 */
router.get(
  '/me/business-qr',
  asyncHandler(async (req, res) => {
    const channelId = req.query.channelId as string | undefined;
    sendOk(res, await business.myCounterQr(req.user!.sub, channelId));
  }),
);

/**
 * Contact matching by hashed phone number. POST (not GET) so the hash list is
 * never placed in a URL, where it would end up in access logs.
 */
router.post(
  '/lookup-by-phones',
  validate({ body: lookupByPhonesBody }),
  asyncHandler(async (req, res) => {
    const { phoneHashes } = req.valid.body as { phoneHashes: string[] };
    sendOk(res, await users.lookupByPhones(phoneHashes, req.user!.sub));
  }),
);

// ── Others ──────────────────────────────────────────────────────────────────
router.get(
  '/discover',
  validate({ query: discoverQuery }),
  asyncHandler(async (req, res) => {
    const { q, limit } = req.valid.query as { q: string; limit: number };
    sendOk(res, await users.discover(q, req.user!.sub, limit));
  }),
);

router.get(
  '/:handle',
  validate({ params: handleParam }),
  asyncHandler(async (req, res) => {
    const { handle } = req.valid.params as { handle: string };
    sendOk(res, await users.getPublicProfile(handle));
  }),
);

export function register(app: Express): void {
  app.use('/users', apiLimiter, router);
}
