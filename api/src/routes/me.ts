import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { query, queryOne } from '@trustroute/shared';
import type { UserRow } from '@trustroute/shared';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { getTrustScoreSnapshot } from '../services/trustScore';
import { checkHandleAvailability } from '../services/handleValidation';
import { changeUserHandle, getHandleChangeStatus } from '../services/handleChange';
import {
  getDiscoverySettings,
  updateDiscoverySettings,
  getNotificationPrefs,
  updateNotificationPrefs,
  getUserConsents,
  updateUserConsents,
} from '../services/userSettings';
import { requestDataExport } from '../services/dataExport';
import { selfDeleteAccount, getDeleteBalanceInfo } from '../services/accountDelete';
import { listBlockedContacts, unblockContact } from '../services/blockedContacts';
import { getWalletSummary } from '../services/wallet';
import { getReferralHome } from '../services/referrals';

export const meRouter = Router();

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v == null ? v : v.trim() === '' ? null : v.trim()));

// ─── GET /me ─────────────────────────────────────────────────────────────────

meRouter.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await queryOne<UserRow>(
      `SELECT user_id, handle, display_name, avatar_url, trust_tier, trust_score,
              identity_id, account_status, legal_name, phone_e164, email, profession, bio,
              business_info, organisation, address, language_pref,
              onboarding_complete, discovery_mode, discovery_contact_book_matching,
              discovery_show_trust_score, shadow_trust_enabled, handle_changed_at,
              is_under_review, review_reason, created_at
       FROM users WHERE user_id = $1`,
      [req.user!.sub],
    );
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');

    const factors = await query(
      `SELECT factor_type, status, verified_at FROM trust_factors WHERE user_id = $1`,
      [user.user_id],
    );

    res.json({
      ok: true,
      data: {
        ...user,
        verified_factors: factors.filter((f) => f.status === 'completed').map((f) => f.factor_type),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /me ───────────────────────────────────────────────────────────────

const updateSchema = z.object({
  display_name: z.string().min(1).max(60).optional(),
  avatar_url: z.string().url().optional(),
  email: optionalText(120),
  profession: optionalText(60),
  organisation: optionalText(120),
  address: optionalText(500),
  bio: optionalText(500),
  business_info: optionalText(1000),
  language_pref: z.string().min(2).max(10).optional(),
  shadow_trust_enabled: z.boolean().optional(),
});

meRouter.patch('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = updateSchema.parse(req.body);
    if (body.email != null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Please enter a valid email address.');
    }

    const updates: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    const setField = (col: string, val: unknown) => {
      updates.push(`${col} = $${i++}`);
      params.push(val);
    };

    if (body.display_name !== undefined) setField('display_name', body.display_name);
    if (body.avatar_url !== undefined) setField('avatar_url', body.avatar_url);
    if (body.email !== undefined) setField('email', body.email);
    if (body.profession !== undefined) setField('profession', body.profession);
    if (body.organisation !== undefined) setField('organisation', body.organisation);
    if (body.address !== undefined) setField('address', body.address);
    if (body.bio !== undefined) setField('bio', body.bio);
    if (body.business_info !== undefined) setField('business_info', body.business_info);
    if (body.language_pref !== undefined) setField('language_pref', body.language_pref);
    if (body.shadow_trust_enabled !== undefined) setField('shadow_trust_enabled', body.shadow_trust_enabled);

    if (updates.length === 0) throw new AppError(400, 'NO_CHANGES', 'Nothing to update.');
    updates.push('updated_at = NOW()');
    params.push(req.user!.sub);

    const [user] = await query<UserRow>(
      `UPDATE users SET ${updates.join(', ')} WHERE user_id = $${i}
       RETURNING user_id, handle, display_name, avatar_url, trust_tier, trust_score,
                 identity_id, account_status, legal_name, phone_e164, email, profession,
                 organisation, address, bio, business_info, language_pref, discovery_mode,
                 shadow_trust_enabled`,
      params,
    );

    res.json({ ok: true, data: user });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── PATCH /me/handle ────────────────────────────────────────────────────────

const handleSchema = z.object({ handle: z.string().min(3).max(30) });

meRouter.get('/handle/status', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = await getHandleChangeStatus(req.user!.sub);
    res.json({ ok: true, data: status });
  } catch (err) {
    next(err);
  }
});

meRouter.get('/handle/check', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const handle = z.string().min(3).parse(req.query.handle);
    const user = await queryOne<{ legal_name: string | null }>(
      `SELECT legal_name FROM users WHERE user_id = $1`,
      [req.user!.sub],
    );
    const result = await checkHandleAvailability(req.user!.sub, user?.legal_name ?? null, handle);
    res.json({ ok: true, data: result });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', 'Enter a handle to check.'));
    next(err);
  }
});

meRouter.patch('/handle', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { handle } = handleSchema.parse(req.body);
    const result = await changeUserHandle(req.user!.sub, handle);
    res.json({ ok: true, data: result });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── PATCH /me/discovery ─────────────────────────────────────────────────────

const discoverySchema = z.object({
  discovery_mode: z.enum(['public', 'private']).optional(),
  contact_book_matching: z.boolean().optional(),
  show_trust_score: z.boolean().optional(),
});

meRouter.get('/discovery', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await getDiscoverySettings(req.user!.sub);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

meRouter.patch('/discovery', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = discoverySchema.parse(req.body);
    const data = await updateDiscoverySettings(req.user!.sub, {
      discovery_mode: body.discovery_mode,
      contact_book_matching: body.contact_book_matching,
      show_trust_score: body.show_trust_score,
    });
    res.json({ ok: true, data });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── GET /me/trust ───────────────────────────────────────────────────────────

meRouter.get('/trust', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const [snapshot, user] = await Promise.all([
      getTrustScoreSnapshot(userId),
      queryOne<{ is_under_review: boolean; review_reason: string | null; account_status: string }>(
        `SELECT is_under_review, review_reason, account_status FROM users WHERE user_id = $1`,
        [userId],
      ),
    ]);

    const tips = [
      'Complete your profile with a photo and bio.',
      'Add trusted contacts who know you.',
      'Keep healthy call patterns — avoid spam-like behaviour.',
    ];

    res.json({
      ok: true,
      data: {
        score: snapshot.total,
        tier: snapshot.tier,
        breakdown: snapshot.factors,
        under_review: user?.is_under_review ?? false,
        review_reason: user?.review_reason ?? null,
        account_status: user?.account_status ?? 'active',
        tips,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET/DELETE /me/blocked ──────────────────────────────────────────────────

meRouter.get('/blocked', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await listBlockedContacts(req.user!.sub);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

meRouter.delete('/blocked/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await unblockContact(req.user!.sub, req.params.id);
    res.json({ ok: true, data: { unblocked: true } });
  } catch (err) {
    next(err);
  }
});

// ─── GET/PATCH /me/notifications ─────────────────────────────────────────────

const notifSchema = z.object({
  enabled: z.boolean().optional(),
  calls: z.boolean().optional(),
  messages: z.boolean().optional(),
  group_messages: z.boolean().optional(),
  company_updates: z.boolean().optional(),
  referral: z.boolean().optional(),
  trust_security: z.boolean().optional(),
  sound: z.boolean().optional(),
  vibrate: z.boolean().optional(),
});

meRouter.get('/notifications', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const prefs = await getNotificationPrefs(req.user!.sub);
    res.json({ ok: true, data: prefs });
  } catch (err) {
    next(err);
  }
});

meRouter.patch('/notifications', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = notifSchema.parse(req.body);
    const prefs = await updateNotificationPrefs(req.user!.sub, body);
    res.json({ ok: true, data: prefs });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── GET/PATCH /me/consents ──────────────────────────────────────────────────

const consentSchema = z.object({
  kyc_use: z.boolean().optional(),
  analytics_opt_out: z.boolean().optional(),
});

meRouter.get('/consents', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const consents = await getUserConsents(req.user!.sub);
    res.json({ ok: true, data: consents });
  } catch (err) {
    next(err);
  }
});

meRouter.patch('/consents', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = consentSchema.parse(req.body);
    const consents = await updateUserConsents(req.user!.sub, body);
    res.json({ ok: true, data: consents });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /me/export ─────────────────────────────────────────────────────────

meRouter.post('/export', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await requestDataExport(req.user!.sub);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

// ─── GET /me/summary (settings home previews) ────────────────────────────────

meRouter.get('/summary', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const [wallet, referral] = await Promise.all([
      getWalletSummary(userId).catch(() => null),
      getReferralHome(userId).catch(() => null),
    ]);
    res.json({
      ok: true,
      data: {
        wallet_balance_paise: wallet?.balance_paise ?? 0,
        referral_available_paise: referral?.wallet?.available_paise ?? 0,
        referral_pending_paise: referral?.wallet?.pending_paise ?? 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /me/delete-preview ──────────────────────────────────────────────────

meRouter.get('/delete-preview', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const balances = await getDeleteBalanceInfo(req.user!.sub);
    res.json({ ok: true, data: balances });
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /me ──────────────────────────────────────────────────────────────

const deleteSchema = z.object({
  confirm_handle: z.string(),
  forfeit_balance: z.boolean().optional(),
  reason: z.string().max(200).optional(),
});

meRouter.delete('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = deleteSchema.parse(req.body);
    const data = await selfDeleteAccount(req.user!.sub, body.confirm_handle, {
      forfeit_balance: body.forfeit_balance,
      reason: body.reason,
    });
    res.json({ ok: true, data });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});
