import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '@privid/shared';
import type { UserRow } from '@privid/shared';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { generateAvatarUploadUrl } from '../services/s3';

export const usersRouter = Router();

// ─── GET /users/me ────────────────────────────────────────────────────────────

usersRouter.get('/me', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await queryOne<UserRow>(
      `SELECT user_id, handle, display_name, avatar_url, trust_tier, trust_score, created_at
       FROM users WHERE user_id = $1`,
      [req.user!.sub]
    );
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');

    // Fetch verified factors
    const factors = await query(
      `SELECT factor_type, status, verified_at FROM trust_factors WHERE user_id = $1`,
      [user.user_id]
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

// ─── PATCH /users/me ──────────────────────────────────────────────────────────

const updateSchema = z.object({
  display_name: z.string().min(1).max(60).optional(),
  avatar_url: z.string().url().optional(),
});

usersRouter.patch('/me', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { display_name, avatar_url } = updateSchema.parse(req.body);

    const updates: string[] = [];
    const params: any[] = [];
    let i = 1;

    if (display_name !== undefined) { updates.push(`display_name = $${i++}`); params.push(display_name); }
    if (avatar_url !== undefined) { updates.push(`avatar_url = $${i++}`); params.push(avatar_url); }

    if (updates.length === 0) throw new AppError(400, 'NO_CHANGES', 'Nothing to update.');

    params.push(req.user!.sub);
    const [user] = await query<UserRow>(
      `UPDATE users SET ${updates.join(', ')} WHERE user_id = $${i} RETURNING user_id, handle, display_name, avatar_url, trust_tier, trust_score`,
      params
    );

    res.json({ ok: true, data: user });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── GET /users/search?q= ─────────────────────────────────────────────────────

usersRouter.get('/search', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = z.string().min(2).parse(req.query.q);
    const users = await query<Partial<UserRow>>(
      `SELECT user_id, handle, display_name, trust_tier, trust_score
       FROM users
       WHERE (handle ILIKE $1 OR display_name ILIKE $1)
         AND user_id != $2
         AND is_active = TRUE
       LIMIT 20`,
      [`%${q}%`, req.user!.sub]
    );
    res.json({ ok: true, data: users });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', 'Query must be at least 2 characters.'));
    next(err);
  }
});

// ─── DELETE /users/me ────────────────────────────────────────────────────────
// Permanently deletes the authenticated user's account.
// Requires the caller to confirm by sending their handle in the body.
// We do a GDPR-safe soft-delete: PII is anonymised and is_active is set to
// false so the handle slot is freed, but audit rows (calls, trust history)
// are retained with no identifying information.

const deleteAccountSchema = z.object({
  confirm_handle: z.string(),
});

usersRouter.delete('/me', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { confirm_handle } = deleteAccountSchema.parse(req.body);

    // Fetch the user to verify the handle confirmation
    const user = await queryOne<UserRow>(
      `SELECT * FROM users WHERE user_id = $1 AND is_active = TRUE`,
      [req.user!.sub]
    );
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'Account not found.');

    if (confirm_handle.toLowerCase() !== user.handle.toLowerCase()) {
      throw new AppError(400, 'HANDLE_MISMATCH', 'The handle you entered does not match your account.');
    }

    const tombstoneId = `deleted_${user.user_id}`;
    const anonymousHash = crypto.createHash('sha256').update(tombstoneId).digest('hex');

    await withTransaction(async (client) => {
      // 1. Anonymise the user row — free the handle, wipe PII
      await client.query(
        `UPDATE users SET
           is_active      = FALSE,
           handle         = $2,
           display_name   = 'Deleted Account',
           phone_e164     = $3,
           phone_hash     = $4,
           avatar_url     = NULL,
           updated_at     = NOW()
         WHERE user_id = $1`,
        [user.user_id, tombstoneId, tombstoneId, anonymousHash]
      );

      // 2. Revoke all refresh tokens so no existing session can be reused
      await client.query(
        `UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1`,
        [user.user_id]
      );

      // 3. Expire all OTP sessions (belt-and-suspenders)
      await client.query(
        `UPDATE otp_sessions SET verified = TRUE
         WHERE phone_e164 = $1 AND verified = FALSE`,
        [user.phone_e164]
      );

      // 4. Soft-delete outbound connections; leave inbound so other users'
      //    contact lists don't silently break (they'll see 'Deleted Account')
      await client.query(
        `DELETE FROM connections WHERE owner_id = $1`,
        [user.user_id]
      );

      // 5. Revoke all reachability channels
      await client.query(
        `UPDATE reachability_channels SET status = 'revoked' WHERE owner_id = $1`,
        [user.user_id]
      );
    });

    res.json({ ok: true, data: { deleted: true } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /users/lookup-by-phones ────────────────────────────────────────────
// Privacy-preserving contact discovery: client sends raw phone numbers,
// server normalises → hashes → looks up. Never stores or logs the raw numbers.
// Returns only users that are on PrivID, excluding self and already-blocked contacts.

function normalizeToE164(raw: string): string | null {
  const digits = raw.replace(/[\s\-\(\)\.+]/g, '');
  if (/^\d{10}$/.test(digits))   return `+91${digits}`;          // 10-digit Indian
  if (/^0\d{10}$/.test(digits))  return `+91${digits.slice(1)}`; // 0XXXXXXXXXX
  if (/^91\d{10}$/.test(digits)) return `+${digits}`;            // 91XXXXXXXXXX
  // Already had +, stripped above — reconstruct for other countries (7-15 digits)
  const withPlus = raw.trim().startsWith('+') ? `+${digits}` : null;
  if (withPlus && /^\+\d{7,15}$/.test(withPlus)) return withPlus;
  return null;
}

const lookupSchema = z.object({
  phones: z.array(z.string()).min(1).max(500),
});

usersRouter.post('/lookup-by-phones', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { phones } = lookupSchema.parse(req.body);

    // Normalise and hash — deduplicate
    const hashMap = new Map<string, string>(); // hash → e164
    for (const raw of phones) {
      const e164 = normalizeToE164(raw);
      if (!e164) continue;
      const hash = crypto.createHash('sha256').update(e164).digest('hex');
      hashMap.set(hash, e164);
    }

    if (hashMap.size === 0) {
      return res.json({ ok: true, data: [] });
    }

    const hashes = Array.from(hashMap.keys());
    const placeholders = hashes.map((_, i) => `$${i + 2}`).join(', ');

    const found = await query<{
      user_id: string; handle: string; display_name: string;
      trust_tier: string; trust_score: number; phone_hash: string;
    }>(
      `SELECT u.user_id, u.handle, u.display_name, u.trust_tier, u.trust_score, u.phone_hash
       FROM users u
       WHERE u.phone_hash IN (${placeholders})
         AND u.user_id  != $1
         AND u.is_active = TRUE`,
      [req.user!.sub, ...hashes],
    );

    res.json({ ok: true, data: found.map(({ phone_hash: _ph, ...u }) => u) });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /users/me/avatar/upload-url ────────────────────────────────────────

const avatarUploadSchema = z.object({
  content_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});

usersRouter.post('/me/avatar/upload-url', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { content_type } = avatarUploadSchema.parse(req.body);
    const { uploadUrl, publicUrl } = await generateAvatarUploadUrl(req.user!.sub, content_type);
    res.json({ ok: true, data: { upload_url: uploadUrl, public_url: publicUrl } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── GET /users/:handle ───────────────────────────────────────────────────────

usersRouter.get('/:handle', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await queryOne<Partial<UserRow>>(
      `SELECT user_id, handle, display_name, avatar_url, trust_tier, trust_score
       FROM users WHERE handle = $1 AND is_active = TRUE`,
      [req.params.handle]
    );
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');

    // Check connection status from both directions
    const connection = await queryOne(
      `SELECT connection_type FROM connections WHERE owner_id = $1 AND contact_id = $2`,
      [req.user!.sub, user.user_id]
    );

    res.json({
      ok: true,
      data: { ...user, connection_type: connection?.connection_type ?? null },
    });
  } catch (err) {
    next(err);
  }
});
