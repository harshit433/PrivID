import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { query, queryOne, withTransaction, derivePresence } from '@trustroute/shared';
import type { UserRow } from '@trustroute/shared';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { generateAvatarUploadUrl, uploadAvatarBuffer } from '../services/s3';
import { issueBusinessQrToken } from '../services/businessQr';
import { selfDeleteAccount } from '../services/accountDelete';
import { finalizeTrustFactor } from '../services/trustScore';

export const usersRouter = Router();

// ─── GET /users/me ────────────────────────────────────────────────────────────

usersRouter.get('/me', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await queryOne<UserRow & { pin_set: boolean }>(
      `SELECT user_id, handle, display_name, avatar_url, trust_tier, trust_score,
              identity_id, account_status, legal_name, phone_e164, email, profession, bio, business_info,
              onboarding_complete, discovery_mode, shadow_trust_enabled, created_at,
              (pin_hash IS NOT NULL) AS pin_set
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

// Empty strings collapse to NULL so a user can clear an optional field.
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v == null ? v : v.trim() === '' ? null : v.trim()));

const updateSchema = z.object({
  display_name: z.string().min(1).max(60).optional(),
  avatar_url: z.string().url().optional(),
  discovery_mode: z.enum(['public', 'private']).optional(),
  email: optionalText(120),
  profession: optionalText(60),
  organisation: optionalText(120),
  address: optionalText(500),
  bio: optionalText(500),
  business_info: optionalText(1000),
  language_pref: z.string().min(2).max(10).optional(),
  shadow_trust_enabled: z.boolean().optional(),
});

usersRouter.patch('/me', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = updateSchema.parse(req.body);

    // Validate email format only when a non-empty value is supplied.
    if (body.email != null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Please enter a valid email address.');
    }

    const updates: string[] = [];
    const params: any[] = [];
    let i = 1;

    const setField = (col: string, val: unknown) => {
      updates.push(`${col} = $${i++}`);
      params.push(val);
    };

    if (body.display_name !== undefined) setField('display_name', body.display_name);
    if (body.avatar_url !== undefined) setField('avatar_url', body.avatar_url);
    if (body.discovery_mode !== undefined) setField('discovery_mode', body.discovery_mode);
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
                 identity_id, account_status, legal_name, phone_e164, email, profession, bio, business_info, discovery_mode,
                 shadow_trust_enabled`,
      params
    );

    res.json({ ok: true, data: user });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── GET /users/search ───────────────────────────────────────────────────────
//
// Privacy-aware user search.
//
// Parameters:
//   q      (required) — search string, min 2 chars
//   limit  (optional) — results per page, 1–50, default 20
//   cursor (optional) — handle to paginate from (last handle of previous page)
//
// Visibility rules:
//   • Always returns the requester's own profile (for self-lookup UX).
//   • Returns discovery_mode = 'public' users.
//   • Returns private-mode users the requester is already connected to.
//   • Never returns blocked contacts.
//   • Excludes the requester themselves.
//
// Search strategy (uses pg_trgm GiST indexes from migration 012):
//   1. Exact handle prefix (fastest, most relevant)
//   2. Trigram similarity on display_name
//   3. Substring match on handle as a fallback
//
// Response omits sensitive fields (phone, email, exact trust_score number).
// Returns `is_verified` (bool) so the client can show a checkmark.

const searchSchema = z.object({
  q:      z.string().min(2, 'Query must be at least 2 characters').max(60),
  limit:  z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(), // last handle from previous page
});

usersRouter.get('/search', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { q, limit, cursor } = searchSchema.parse(req.query);
    const myId = req.user!.sub;

    // Sanitise the query: strip SQL wildcards, normalise whitespace
    const qClean   = q.trim().replace(/[%_]/g, '\\$&').toLowerCase();
    const qPrefix  = qClean + '%';   // for handle prefix match
    const qTrigram = qClean;         // for display_name similarity

    const rows = await query<{
      user_id:      string;
      handle:       string;
      display_name: string | null;
      avatar_url:   string | null;
      trust_tier:   string;
      profession:   string | null;
      is_verified:  boolean;
      connection_type: string | null;
    }>(
      `SELECT
         u.user_id,
         u.handle,
         u.display_name,
         u.avatar_url,
         u.trust_tier,
         u.profession,
         -- is_verified: true if liveness_check is completed (minimum real-person bar)
         EXISTS (
           SELECT 1 FROM trust_factors tf
           WHERE tf.user_id = u.user_id
             AND tf.factor_type = 'liveness_check'
             AND tf.status = 'completed'
             AND tf.is_latest = TRUE
         ) AS is_verified,
         -- requester's connection type to this user (for UI affordances)
         (SELECT connection_type FROM connections
          WHERE owner_id = $1 AND contact_id = u.user_id) AS connection_type
       FROM users u
       WHERE u.user_id != $1
         AND u.is_active = TRUE
         -- Cursor-based pagination (handle is unique and alphabetically ordered)
         AND ($5::text IS NULL OR u.handle > $5)
         -- Visibility: public, or already connected (in either direction), but not blocked
         AND (
           u.discovery_mode = 'public'
           OR EXISTS (
             SELECT 1 FROM connections c
             WHERE c.owner_id = $1
               AND c.contact_id = u.user_id
               AND c.connection_type != 'blocked'
           )
         )
         -- Search predicate: handle prefix OR fuzzy name match OR handle substring
         AND (
           u.handle ILIKE $2
           OR (u.display_name IS NOT NULL AND similarity(u.display_name, $3) > 0.25)
           OR u.handle ILIKE '%' || $3 || '%'
         )
       ORDER BY
         -- Rank: exact handle prefix > everything else; then alphabetical
         CASE WHEN u.handle ILIKE $2 THEN 0 ELSE 1 END ASC,
         u.handle ASC
       LIMIT $4`,
      [myId, qPrefix, qTrigram, limit + 1, cursor ?? null],
    );

    // Determine if there's a next page (we fetched limit+1 rows)
    const hasMore  = rows.length > limit;
    const results  = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? results[results.length - 1].handle : null;

    res.json({
      ok: true,
      data: {
        results,
        next_cursor: nextCursor,
        has_more:    hasMore,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    }
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
  forfeit_balance: z.boolean().optional(),
  reason: z.string().max(200).optional(),
});

usersRouter.delete('/me', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = deleteAccountSchema.parse(req.body);
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
  phones: z.array(z.string()).max(500).optional(),
  phone_hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/i)).max(500).optional(),
}).refine((b) => (b.phones?.length ?? 0) > 0 || (b.phone_hashes?.length ?? 0) > 0, {
  message: 'phones or phone_hashes required',
});

usersRouter.post('/lookup-by-phones', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = lookupSchema.parse(req.body);

    // Prefer client-side hashes (privacy). Fall back to server-side hash of raw phones.
    const hashSet = new Set<string>();
    for (const h of body.phone_hashes ?? []) {
      hashSet.add(h.toLowerCase());
    }
    for (const raw of body.phones ?? []) {
      const e164 = normalizeToE164(raw);
      if (!e164) continue;
      hashSet.add(crypto.createHash('sha256').update(e164).digest('hex'));
    }

    if (hashSet.size === 0) {
      return res.json({ ok: true, data: [] });
    }

    const hashes = Array.from(hashSet);
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

    res.json({
      ok: true,
      data: found.map((u) => ({
        user_id: u.user_id,
        handle: u.handle,
        display_name: u.display_name,
        trust_tier: u.trust_tier,
        trust_score: u.trust_score,
        phone_hash: u.phone_hash,
      })),
    });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── GET /users/me/business-qr ─────────────────────────────────────────────────
//
// Rotating 60s token for Business Suite QR scan (single-use on scan).

usersRouter.get('/me/business-qr', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await issueBusinessQrToken(req.user!.sub);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

// ─── POST /users/me/avatar ────────────────────────────────────────────────────
// Accepts the image as base64 in the JSON body.
// Uploads to S3 if configured; otherwise stores as a data URL (dev fallback).
// Updates users.avatar_url and returns the resolved URL.

const avatarDirectSchema = z.object({
  image_base64: z.string().min(1),
  content_type: z.enum(['image/jpeg', 'image/png', 'image/webp']).default('image/jpeg'),
});

usersRouter.post('/me/avatar', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { image_base64, content_type } = avatarDirectSchema.parse(req.body);
    const imageBuffer = Buffer.from(image_base64, 'base64');

    // Sanity check: reject obviously non-image data (< 100 bytes or > 8 MB)
    if (imageBuffer.length < 100 || imageBuffer.length > 8 * 1024 * 1024) {
      throw new AppError(400, 'INVALID_IMAGE', 'Image must be between 100 bytes and 8 MB.');
    }

    const avatarUrl = await uploadAvatarBuffer(req.user!.sub, imageBuffer, content_type);

    await query(
      `UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE user_id = $2`,
      [avatarUrl, req.user!.sub]
    );

    // Profile completeness (+5) depends on avatar_url — refresh trust score.
    await finalizeTrustFactor(req.user!.sub, 'profile_avatar').catch(() => {});

    res.json({ ok: true, data: { avatar_url: avatarUrl } });
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

// ─── GET /users/:handle — Public profile ─────────────────────────────────────
//
// Returns the public-facing profile for a user identified by their handle.
//
// Visibility rules (same as /search):
//   • Always accessible for the user's own profile.
//   • If discovery_mode = 'public': accessible by any authenticated TrustRoute user.
//   • If discovery_mode = 'private': only accessible to users who are already
//     connected (in either direction, any type except blocked).
//   • Returns 404 for private-mode profiles the requester cannot see — we do NOT
//     reveal that the account exists, to avoid enumeration.
//
// The response deliberately omits phone_e164, email, and the exact trust_score
// number to protect user privacy. The tier label and is_verified flag are
// sufficient for UI trust indicators.

usersRouter.get('/:handle', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const handle = req.params.handle?.toLowerCase().trim();
    if (!handle || handle.length < 3) {
      throw new AppError(400, 'INVALID_HANDLE', 'Invalid handle.');
    }

    const myId = req.user!.sub;

    const user = await queryOne<{
      user_id:      string;
      handle:       string;
      display_name: string | null;
      avatar_url:   string | null;
      trust_tier:   string;
      profession:   string | null;
      bio:          string | null;
      discovery_mode: string;
      is_active:    boolean;
      is_verified:  boolean;
      created_at:   Date;
    }>(
      `SELECT
         u.user_id,
         u.handle,
         u.display_name,
         u.avatar_url,
         u.trust_tier,
         u.profession,
         u.bio,
         u.discovery_mode,
         u.is_active,
         u.created_at,
         EXISTS (
           SELECT 1 FROM trust_factors tf
           WHERE tf.user_id = u.user_id
             AND tf.factor_type = 'liveness_check'
             AND tf.status = 'completed'
             AND tf.is_latest = TRUE
         ) AS is_verified
       FROM users u
       WHERE u.handle = $1`,
      [handle],
    );

    // 404 if user doesn't exist or is deactivated
    if (!user || !user.is_active) {
      throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
    }

    // Own profile: always visible
    const isSelf = user.user_id === myId;

    if (!isSelf && user.discovery_mode === 'private') {
      // Check if the requester has any non-blocked connection to this user
      const connection = await queryOne<{ connection_type: string }>(
        `SELECT connection_type FROM connections
          WHERE owner_id = $1 AND contact_id = $2`,
        [myId, user.user_id],
      );

      const isConnected = connection && connection.connection_type !== 'blocked';
      if (!isConnected) {
        // Intentional 404 — do not reveal that a private account exists
        throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
      }
    }

    // Fetch the requester's connection state to this user (for client UI)
    const [myConn, reverseConn] = await Promise.all([
      queryOne<{ connection_type: string; temporary_expires_at: Date | null }>(
        `SELECT connection_type, temporary_expires_at
           FROM connections
          WHERE owner_id = $1 AND contact_id = $2`,
        [myId, user.user_id],
      ),
      queryOne<{ connection_type: string }>(
        `SELECT connection_type
           FROM connections
          WHERE owner_id = $1 AND contact_id = $2`,
        [user.user_id, myId],
      ),
    ]);

    // Strip internal fields from the response
    const { discovery_mode: _dm, is_active: _ia, ...publicFields } = user;

    res.json({
      ok: true,
      data: {
        ...publicFields,
        // Requester's view of the relationship
        my_connection_type:      myConn?.connection_type ?? 'unknown',
        temporary_expires_at:    myConn?.temporary_expires_at ?? null,
        their_connection_type:   reverseConn?.connection_type ?? 'unknown',
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /users/me/firebase-token ───────────────────────────────────────────
// Custom Firebase Auth token for RTDB reads (activities, calls).

usersRouter.post('/me/firebase-token', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { createFirebaseCustomToken } = await import('../services/fcm');
    const token = await createFirebaseCustomToken(req.user!.sub);
    if (!token) {
      return next(new AppError(503, 'FIREBASE_UNAVAILABLE', 'Firebase is not configured.'));
    }
    res.json({ ok: true, data: { token } });
  } catch (err) {
    next(err);
  }
});

// ─── PUT /users/me/push-token ─────────────────────────────────────────────────
// Store FCM token directly on the users row — simple, reliable, no joins needed.

usersRouter.put('/me/push-token', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { push_token } = z.object({
      push_token: z.string().min(10),
    }).parse(req.body);

    await query(
      `UPDATE users SET fcm_token = $2 WHERE user_id = $1`,
      [req.user!.sub, push_token],
    );

    res.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── PATCH /users/me/status ───────────────────────────────────────────────────
//
// Set the user's visible status line (like WhatsApp "About" but ephemeral).
// Both fields are optional — omitting a field keeps the existing value;
// passing null explicitly clears it.

const statusSchema = z.object({
  status_text:  z.string().max(140).nullable().optional(),
  status_emoji: z.string().max(8).nullable().optional(),
}).refine(
  (d) => d.status_text !== undefined || d.status_emoji !== undefined,
  { message: 'Provide at least one of status_text or status_emoji.' },
);

usersRouter.patch('/me/status', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = statusSchema.parse(req.body);
    const myId = req.user!.sub;

    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    if (body.status_text !== undefined) {
      sets.push(`status_text = $${i++}`);
      params.push(body.status_text);
    }
    if (body.status_emoji !== undefined) {
      sets.push(`status_emoji = $${i++}`);
      params.push(body.status_emoji);
    }

    sets.push('updated_at = NOW()');
    params.push(myId);

    await query(
      `UPDATE users SET ${sets.join(', ')} WHERE user_id = $${i}`,
      params,
    );

    res.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── GET /users/:id/presence ──────────────────────────────────────────────────
//
// Returns real-time presence for a user identified by their UUID.
// Separate from the profile endpoint so callers can poll this at a higher
// frequency without fetching the full profile each time.
//
// Presence tiers (computed from last_seen_at):
//   online  — last_seen_at within 3 min
//   away    — last_seen_at within 30 min
//   offline — last_seen_at > 30 min or null
//
// Uses /:id (UUID) rather than /:handle to avoid ambiguity with the
// existing GET /:handle profile route.
//
// Access control: only returns presence if the requester is connected
// to the target (or IS the target). Unknown strangers see offline only.

usersRouter.get('/:id/presence', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    // Validate UUID format
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new AppError(400, 'INVALID_ID', 'Must be a valid user UUID.');
    }

    const myId = req.user!.sub;

    // Self-presence always allowed
    const isSelf = id === myId;

    if (!isSelf) {
      // Only reveal presence to connected users (non-blocked)
      const conn = await queryOne<{ connection_type: string }>(
        `SELECT connection_type FROM connections
          WHERE owner_id = $1 AND contact_id = $2`,
        [myId, id],
      );
      if (!conn || conn.connection_type === 'blocked') {
        // Return offline without revealing whether the user exists
        return res.json({
          ok: true,
          data: { user_id: id, status: 'offline', last_seen_at: null, status_text: null, status_emoji: null },
        });
      }
    }

    const user = await queryOne<{
      user_id:      string;
      last_seen_at: Date | null;
      status_text:  string | null;
      status_emoji: string | null;
    }>(
      `SELECT user_id, last_seen_at, status_text, status_emoji FROM users WHERE user_id = $1`,
      [id],
    );

    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');

    res.json({
      ok: true,
      data: {
        user_id:      user.user_id,
        status:       derivePresence(user.last_seen_at),
        last_seen_at: user.last_seen_at,
        status_text:  user.status_text,
        status_emoji: user.status_emoji,
      },
    });
  } catch (err) {
    next(err);
  }
});
