import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import {
  query,
  queryOne,
  withTransaction,
  type IdentityRow,
  type OnboardingSessionRow,
  type UserRow,
} from '@trustroute/shared';
import { AppError } from '../middleware/errorHandler';
import { requireAuth } from '../middleware/auth';
import {
  createDigilockerRequest,
  getDigilockerStatus,
  fetchAadhaar,
  DigilockerError,
} from '../services/digilocker';
import { isLivenessAvailable, checkLiveness, livenessThreshold } from '../services/liveness';
import { recomputeAndPersist } from '../services/trustScore';
import { buildHandleCandidates } from '../utils/handles';
import { assertCanAuthenticate, getLatestAppeal } from '../services/accountState';
import { logger } from '../utils/logger';
import { applyReferralOnOnboardingComplete, ensureReferralCode } from '../services/referrals';
import {
  canCompleteLiveness,
  canStartDigilocker,
  canStartLiveness,
  computeNextStep,
} from '../services/onboardingProgress';

export const onboardingRouter = Router();

/** Long enough to resume mid-flow after app kill; bumped again on each step. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function sessionExpiry(): Date {
  return new Date(Date.now() + SESSION_TTL_MS);
}
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let _privateKey: string | null = null;
function getPrivateKey(): string {
  if (!_privateKey) {
    if (process.env.JWT_PRIVATE_KEY_B64) {
      _privateKey = Buffer.from(process.env.JWT_PRIVATE_KEY_B64, 'base64').toString('utf8');
    } else {
      const p = process.env.JWT_PRIVATE_KEY_PATH ?? './keys/private.pem';
      _privateKey = fs.readFileSync(path.resolve(p), 'utf8');
    }
  }
  return _privateKey;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashOptional(raw?: string | null): string | null {
  const value = raw?.trim();
  return value ? crypto.createHash('sha256').update(value).digest('hex') : null;
}

function issueTokens(user: Pick<UserRow, 'user_id' | 'handle' | 'trust_tier'>): {
  accessToken: string;
  refreshToken: string;
} {
  const accessToken = jwt.sign(
    { sub: user.user_id, handle: user.handle, tier: user.trust_tier },
    getPrivateKey(),
    { algorithm: 'RS256', expiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '24h' } as any,
  );
  return { accessToken, refreshToken: crypto.randomBytes(40).toString('base64url') };
}

async function issueAuthResponse(user: UserRow, revokeExisting = false): Promise<object> {
  const { accessToken, refreshToken } = issueTokens(user);
  await withTransaction(async (client) => {
    if (revokeExisting) {
      await client.query(`UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1`, [user.user_id]);
    }
    await client.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [user.user_id, hashToken(refreshToken), new Date(Date.now() + REFRESH_TOKEN_TTL_MS)],
    );
  });

  return {
    ok: true,
    data: {
      access_token: accessToken,
      refresh_token: refreshToken,
      user: authUserPayload(user),
    },
  };
}

function authUserPayload(user: UserRow): object {
  return {
    user_id: user.user_id,
    identity_id: user.identity_id,
    handle: user.handle,
    display_name: user.display_name,
    legal_name: user.legal_name,
    trust_tier: user.trust_tier,
    trust_score: user.trust_score,
    avatar_url: user.avatar_url,
    onboarding_complete: user.onboarding_complete ?? false,
    discovery_mode: user.discovery_mode,
    account_status: user.account_status,
    phone_e164: user.phone_e164,
    phone_verified: Boolean(user.phone_e164),
    pin_set: Boolean(user.pin_hash),
  };
}

function friendlyDigilocker(code: string): string {
  if (code === 'DIGILOCKER_NOT_CONFIGURED')
    return 'Identity verification is briefly unavailable. Please try again soon.';
  if (code === 'DIGILOCKER_TIMEOUT')
    return 'DigiLocker is taking longer than usual. Please try again.';
  return 'We couldn’t verify with DigiLocker. Please try again.';
}

async function getSession(sessionId: string): Promise<OnboardingSessionRow> {
  const session = await queryOne<OnboardingSessionRow>(
    `SELECT * FROM onboarding_sessions WHERE session_id = $1`,
    [sessionId],
  );
  if (!session) throw new AppError(404, 'SESSION_NOT_FOUND', 'Verification session not found.');
  if (new Date(session.expires_at) < new Date()) {
    await query(`UPDATE onboarding_sessions SET status = 'expired' WHERE session_id = $1`, [sessionId]).catch(() => {});
    throw new AppError(410, 'SESSION_EXPIRED', 'Your verification timed out. Let’s start again.');
  }
  return session;
}

function normalizeHandle(input: string): string {
  return input.trim().toLowerCase().replace(/^@/, '');
}

function cleanToken(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function handleMatchesLegalName(handle: string, legalName: string): boolean {
  const h = cleanToken(handle);
  const tokens = legalName
    .split(/\s+/)
    .map(cleanToken)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return true;
  return tokens.some((token) => h.includes(token));
}

async function validateHandleForSession(session: OnboardingSessionRow, rawHandle: string): Promise<string> {
  const handle = normalizeHandle(rawHandle);
  if (!/^[a-z0-9._]{3,30}$/.test(handle)) {
    throw new AppError(400, 'HANDLE_INVALID', 'Handles can use letters, numbers, dots and underscores.');
  }
  if (!session.legal_name) {
    throw new AppError(409, 'IDENTITY_NOT_VERIFIED', 'Verify your identity before choosing a handle.');
  }
  if (!handleMatchesLegalName(handle, session.legal_name)) {
    throw new AppError(400, 'HANDLE_NAME_MISMATCH', `Your handle should be based on your verified name, ${session.legal_name}.`);
  }
  const taken = await queryOne<{ user_id: string }>(
    `SELECT user_id FROM users WHERE handle = $1`,
    [handle],
  );
  if (taken) throw new AppError(409, 'HANDLE_TAKEN', `@${handle} is taken. Try another.`);
  return handle;
}

function branchForIdentity(identity: IdentityRow | null, user?: Pick<UserRow, 'account_status'> | null): OnboardingSessionRow['branch'] {
  if (!identity) return 'new';
  if (identity.status === 'banned' || identity.status === 'ousted' || identity.status === 'suspended') return identity.status;
  if (identity.status === 'self_deleted') return 'self_deleted';
  if (user?.account_status === 'self_deleted') return 'self_deleted';
  if (user?.account_status === 'banned' || user?.account_status === 'ousted' || user?.account_status === 'suspended') {
    return user.account_status;
  }
  if (identity.current_user_id) return 'active';
  return 'new';
}

async function buildStatusPayload(session: OnboardingSessionRow): Promise<object> {
  const appeal = await getLatestAppeal({
    userId: session.matched_user_id,
    identityId: session.identity_id,
  });
  let lastHandle: string | null = null;
  if (session.identity_id) {
    const identity = await queryOne<{ last_handle: string | null }>(
      `SELECT last_handle FROM identities WHERE identity_id = $1`,
      [session.identity_id],
    );
    lastHandle = identity?.last_handle ?? null;
  }
  return {
    session_id: session.session_id,
    purpose: session.purpose,
    status: session.status,
    next_step: computeNextStep(session),
    branch: session.branch,
    identity_id: session.identity_id,
    matched_user_id: session.matched_user_id,
    legal_name: session.legal_name,
    selected_handle: session.selected_handle,
    pending_display_name: session.pending_display_name,
    last_handle: lastHandle,
    expires_at: new Date(session.expires_at).toISOString(),
    appeal,
  };
}

// ─── POST /onboarding/start ──────────────────────────────────────────────────

const startSchema = z.object({
  purpose: z.enum(['signup', 'recovery', 'pin_reset']).default('signup'),
  device_fingerprint: z.string().max(500).optional(),
  integrity_verdict: z.record(z.unknown()).optional(),
});

onboardingRouter.post('/start', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = startSchema.parse(req.body ?? {});
    const fingerprintHash = hashOptional(body.device_fingerprint);
    const [session] = await query<OnboardingSessionRow>(
      `INSERT INTO onboarding_sessions
         (purpose, status, device_fingerprint_hash, integrity_verdict, expires_at)
       VALUES ($1, 'device_checked', $2, $3, $4)
       RETURNING *`,
      [
        body.purpose,
        fingerprintHash,
        JSON.stringify(body.integrity_verdict ?? {}),
        sessionExpiry(),
      ],
    );

    if (fingerprintHash) {
      const blocked = await queryOne<{ user_id: string }>(
        `SELECT u.user_id
           FROM onboarding_sessions os
           JOIN users u ON u.user_id = os.matched_user_id
          WHERE os.device_fingerprint_hash = $1
            AND u.account_status IN ('banned', 'ousted')
          LIMIT 1`,
        [fingerprintHash],
      );
      if (blocked) {
        throw new AppError(
          403,
          'DEVICE_BANNED',
          'This device cannot be used with TrustRoute. You can request a review.',
          { session_id: session.session_id },
        );
      }
    }

    res.status(201).json({ ok: true, data: await buildStatusPayload(session) });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── GET /onboarding/session ─────────────────────────────────────────────────
/** Resume checkpoint — returns status + exact next_step for client routing. */

onboardingRouter.get('/session', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session_id = z.string().uuid().parse(req.query.session_id);
    const session = await getSession(session_id);
    res.json({ ok: true, data: await buildStatusPayload(session) });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /onboarding/digilocker/init ────────────────────────────────────────

const sessionSchema = z.object({ session_id: z.string().uuid() });

onboardingRouter.post('/digilocker/init', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { session_id } = sessionSchema.parse(req.body);
    const existing = await getSession(session_id);
    if (!canStartDigilocker(existing.status)) {
      throw new AppError(
        409,
        'STEP_PASSED',
        'DigiLocker is already done for this session. Continue from the next step.',
        { next_step: computeNextStep(existing), status: existing.status },
      );
    }
    const dg = await createDigilockerRequest();
    const [session] = await query<OnboardingSessionRow>(
      `UPDATE onboarding_sessions
          SET status = 'digilocker_started',
              digilocker_provider_ref = $2,
              expires_at = $3,
              updated_at = NOW()
        WHERE session_id = $1
        RETURNING *`,
      [session_id, dg.id, sessionExpiry()],
    );
    res.json({ ok: true, data: { ...(await buildStatusPayload(session)), auth_url: dg.url, provider_ref: dg.id } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    if (err instanceof DigilockerError) return next(new AppError(err.httpStatus, err.code, friendlyDigilocker(err.code)));
    next(err);
  }
});

// ─── POST /onboarding/digilocker/complete ────────────────────────────────────

onboardingRouter.post('/digilocker/complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { session_id } = sessionSchema.parse(req.body);
    const existingSession = await getSession(session_id);
    if (
      existingSession.status === 'digilocker_verified' ||
      existingSession.status === 'liveness_started' ||
      existingSession.status === 'liveness_verified' ||
      existingSession.status === 'matched' ||
      existingSession.status === 'completed'
    ) {
      return res.json({
        ok: true,
        data: { ...(await buildStatusPayload(existingSession)), pending: false },
      });
    }
    const providerRef = existingSession.digilocker_provider_ref;
    if (!providerRef) throw new AppError(409, 'DIGILOCKER_NOT_STARTED', 'Start DigiLocker verification first.');

    const dgStatus = await getDigilockerStatus(providerRef);
    if (dgStatus !== 'authenticated') {
      return res.json({ ok: true, data: { ...(await buildStatusPayload(existingSession)), provider_status: dgStatus, pending: true } });
    }

    const aadhaar = await fetchAadhaar(providerRef);

    const [session] = await withTransaction(async (client) => {
      const identityResult = await client.query<IdentityRow>(
        `INSERT INTO identities (legal_name, doc_type, doc_hash, provider, provider_ref, status)
         VALUES ($1, 'aadhaar', $2, 'setu', $3, 'active')
         ON CONFLICT (doc_hash) DO UPDATE
           SET legal_name = EXCLUDED.legal_name,
               provider = EXCLUDED.provider,
               provider_ref = COALESCE(identities.provider_ref, EXCLUDED.provider_ref),
               updated_at = NOW()
         RETURNING *`,
        [aadhaar.legalName, aadhaar.docHash, providerRef],
      );
      const identity = identityResult.rows[0]!;
      const userResult = identity.current_user_id
        ? await client.query<Pick<UserRow, 'user_id' | 'account_status'>>(
            `SELECT user_id, account_status FROM users WHERE user_id = $1`,
            [identity.current_user_id],
          )
        : { rows: [] as Array<Pick<UserRow, 'user_id' | 'account_status'>> };
      const user = userResult.rows[0] ?? null;
      const branch = branchForIdentity(identity, user);
      const matchedUserId = identity.current_user_id ?? null;

      const updated = await client.query<OnboardingSessionRow>(
        `UPDATE onboarding_sessions
            SET status = 'digilocker_verified',
                legal_name = $2,
                doc_type = 'aadhaar',
                doc_hash = $3,
                identity_id = $4,
                matched_user_id = $5,
                branch = $6,
                doc_photo_b64 = COALESCE($7, doc_photo_b64),
                expires_at = $8,
                updated_at = NOW()
          WHERE session_id = $1
          RETURNING *`,
        [
          session_id,
          aadhaar.legalName,
          aadhaar.docHash,
          identity.identity_id,
          matchedUserId,
          branch,
          aadhaar.photoBase64 ?? null,
          sessionExpiry(),
        ],
      );
      return updated.rows;
    });

    res.json({ ok: true, data: { ...(await buildStatusPayload(session)), pending: false } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    if (err instanceof DigilockerError) return next(new AppError(err.httpStatus, err.code, friendlyDigilocker(err.code)));
    next(err);
  }
});

// ─── POST /onboarding/liveness/init ──────────────────────────────────────────

onboardingRouter.post('/liveness/init', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { session_id } = sessionSchema.parse(req.body);
    const session = await getSession(session_id);
    if (!session.identity_id || !session.legal_name) {
      throw new AppError(409, 'IDENTITY_NOT_VERIFIED', 'Verify your identity before the face check.');
    }
    if (!canStartLiveness(session.status)) {
      throw new AppError(
        409,
        session.status === 'digilocker_started' || session.status === 'device_checked' || session.status === 'started'
          ? 'DIGILOCKER_REQUIRED'
          : 'STEP_PASSED',
        session.status === 'digilocker_started' || session.status === 'device_checked' || session.status === 'started'
          ? 'Finish DigiLocker before the face check.'
          : 'Face check is already done. Continue from the next step.',
        { next_step: computeNextStep(session), status: session.status },
      );
    }
    if (!isLivenessAvailable()) {
      throw new AppError(503, 'LIVENESS_UNAVAILABLE', 'Liveness verification is not available right now. Please try again later.');
    }
    const providerRef = crypto.randomUUID();
    const [updated] = await query<OnboardingSessionRow>(
      `UPDATE onboarding_sessions
          SET status = 'liveness_started',
              liveness_provider_ref = $2,
              expires_at = $3,
              updated_at = NOW()
        WHERE session_id = $1
        RETURNING *`,
      [session_id, providerRef, sessionExpiry()],
    );
    res.json({ ok: true, data: { ...(await buildStatusPayload(updated)), provider_ref: providerRef, liveness_enabled: true } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /onboarding/liveness/complete ──────────────────────────────────────

const livenessCompleteSchema = z.object({
  session_id: z.string().uuid(),
  provider_ref: z.string().min(8),
  image: z.string().min(100),
});

onboardingRouter.post('/liveness/complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = livenessCompleteSchema.parse(req.body);
    const session = await getSession(body.session_id);
    if (!canCompleteLiveness(session.status)) {
      throw new AppError(
        409,
        'LIVENESS_REQUIRED',
        'Start the face check before submitting a selfie.',
        { next_step: computeNextStep(session), status: session.status },
      );
    }
    if (!session.liveness_provider_ref || session.liveness_provider_ref !== body.provider_ref) {
      throw new AppError(404, 'LIVENESS_SESSION_NOT_FOUND', 'Face check session not found.');
    }
    if (!isLivenessAvailable()) {
      throw new AppError(503, 'LIVENESS_UNAVAILABLE', 'Liveness verification is not available right now. Please try again later.');
    }

    const b64 = body.image.includes(',') ? body.image.slice(body.image.indexOf(',') + 1) : body.image;
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 1024) throw new AppError(400, 'IMAGE_INVALID', 'The captured selfie was empty. Please try again.');

    const result = await checkLiveness(buf).catch((err: Error) => {
      logger.error('onboarding/liveness', 'Provider check failed', { error: err.message });
      throw new AppError(502, 'LIVENESS_CHECK_FAILED', 'Liveness verification is temporarily unavailable. Please try again.');
    });

    if (!result.real) {
      throw new AppError(
        400,
        'LIVENESS_FAILED',
        `We couldn’t confirm your face. Use good lighting, hold steady, and try again.`,
      );
    }

    // Face-to-document match was removed — after liveness we only resolve identity/account branch.
    const identity = await queryOne<IdentityRow>(
      `SELECT * FROM identities WHERE identity_id = $1`,
      [session.identity_id],
    );
    const linkedUser = session.matched_user_id
      ? await queryOne<Pick<UserRow, 'user_id' | 'account_status'>>(
          `SELECT user_id, account_status FROM users WHERE user_id = $1`,
          [session.matched_user_id],
        )
      : null;
    const branch = branchForIdentity(identity, linkedUser);
    const matchedUserId = identity?.current_user_id ?? session.matched_user_id ?? null;

    const [updated] = await query<OnboardingSessionRow>(
      `UPDATE onboarding_sessions
          SET status = 'matched',
              branch = $2,
              matched_user_id = COALESCE($3, matched_user_id),
              selfie_b64 = $4,
              doc_photo_b64 = NULL,
              expires_at = $5,
              updated_at = NOW()
        WHERE session_id = $1
        RETURNING *`,
      [body.session_id, branch, matchedUserId, b64, sessionExpiry()],
    );

    res.json({
      ok: true,
      data: {
        ...(await buildStatusPayload(updated)),
        liveness: { score: result.score, threshold: livenessThreshold() },
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /onboarding/match ───────────────────────────────────────────────────
// Kept for older clients / resume of sessions left at liveness_verified.
// No face-to-document compare — identity/account dedup only.

onboardingRouter.post('/match', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { session_id } = sessionSchema.parse(req.body);
    const session = await getSession(session_id);
    if (!session.identity_id || !session.legal_name) {
      throw new AppError(409, 'IDENTITY_NOT_VERIFIED', 'Verify with DigiLocker before continuing.');
    }
    if (
      session.status !== 'liveness_verified' &&
      session.status !== 'matched' &&
      session.status !== 'liveness_started'
    ) {
      throw new AppError(409, 'LIVENESS_REQUIRED', 'Complete the face check before continuing.');
    }

    const identity = await queryOne<IdentityRow>(
      `SELECT * FROM identities WHERE identity_id = $1`,
      [session.identity_id],
    );
    const user = session.matched_user_id
      ? await queryOne<Pick<UserRow, 'user_id' | 'account_status'>>(
          `SELECT user_id, account_status FROM users WHERE user_id = $1`,
          [session.matched_user_id],
        )
      : null;
    const branch = branchForIdentity(identity, user);
    const matchedUserId = identity?.current_user_id ?? session.matched_user_id ?? null;

    const [updated] = await query<OnboardingSessionRow>(
      `UPDATE onboarding_sessions
          SET status = 'matched',
              branch = $2,
              matched_user_id = COALESCE($3, matched_user_id),
              doc_photo_b64 = NULL,
              selfie_b64 = NULL,
              expires_at = $4,
              updated_at = NOW()
        WHERE session_id = $1
        RETURNING *`,
      [session_id, branch, matchedUserId, sessionExpiry()],
    );

    res.json({
      ok: true,
      data: await buildStatusPayload(updated),
    });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /onboarding/handle ──────────────────────────────────────────────────
// ON-17 · Reserve handle + display name without creating the user account.

const setHandleSchema = z.object({
  session_id: z.string().uuid(),
  handle: z.string().min(3).max(30),
  display_name: z.string().min(2).max(60).optional(),
});

onboardingRouter.post('/handle', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = setHandleSchema.parse(req.body);
    const session = await getSession(body.session_id);
    if (session.status !== 'matched' && session.status !== 'liveness_verified') {
      throw new AppError(409, 'MATCH_REQUIRED', 'Complete identity matching before choosing a handle.');
    }
    const handle = await validateHandleForSession(session, body.handle);
    const [updated] = await query<OnboardingSessionRow>(
      `UPDATE onboarding_sessions
          SET selected_handle = $2,
              pending_display_name = COALESCE($3, pending_display_name, legal_name),
              expires_at = $4,
              updated_at = NOW()
        WHERE session_id = $1
        RETURNING *`,
      [body.session_id, handle, body.display_name?.trim() ?? null, sessionExpiry()],
    );
    res.json({ ok: true, data: await buildStatusPayload(updated) });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    if (err instanceof AppError && ['HANDLE_TAKEN', 'HANDLE_INVALID', 'HANDLE_NAME_MISMATCH'].includes(err.code)) {
      return res.status(err.statusCode).json({ ok: false, error: { code: err.code, message: err.message } });
    }
    next(err);
  }
});

// ─── GET /onboarding/handle/check ────────────────────────────────────────────

onboardingRouter.get('/handle/check', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = z.object({
      session_id: z.string().uuid(),
      handle: z.string().min(1),
    }).parse(req.query);
    const session = await getSession(parsed.session_id);
    const handle = await validateHandleForSession(session, parsed.handle);
    await query(
      `UPDATE onboarding_sessions SET selected_handle = $2, updated_at = NOW() WHERE session_id = $1`,
      [session.session_id, handle],
    );
    res.json({ ok: true, data: { available: true, handle } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    if (err instanceof AppError && ['HANDLE_TAKEN', 'HANDLE_INVALID', 'HANDLE_NAME_MISMATCH'].includes(err.code)) {
      return res.status(err.statusCode).json({ ok: false, error: { code: err.code, message: err.message } });
    }
    next(err);
  }
});

// ─── GET /onboarding/handle/suggest ──────────────────────────────────────────

onboardingRouter.get('/handle/suggest', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = z.object({ session_id: z.string().uuid() }).parse(req.query);
    const session = await getSession(parsed.session_id);
    if (!session.legal_name) throw new AppError(409, 'IDENTITY_NOT_VERIFIED', 'Verify your identity before choosing a handle.');
    const legalName = session.legal_name;
    const candidates = buildHandleCandidates(legalName)
      .map((h) => h.replace(/_/g, '.'))
      .filter((h) => handleMatchesLegalName(h, legalName));
    const rows = candidates.length
      ? await query<{ handle: string }>(`SELECT handle FROM users WHERE handle = ANY($1::text[])`, [candidates])
      : [];
    const taken = new Set(rows.map((r) => r.handle));
    const suggestions = [...new Set(candidates)].filter((h) => !taken.has(h)).slice(0, 5);
    res.json({ ok: true, data: { suggestions } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /onboarding/complete ───────────────────────────────────────────────

const completeSchema = z.object({
  session_id: z.string().uuid(),
  handle: z.string().min(1).optional(),
  display_name: z.string().min(1).max(60).optional(),
  phone_e164: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(),
});

async function createVerifiedUserFromSession(session: OnboardingSessionRow, handle: string, displayName?: string, phoneE164?: string): Promise<UserRow> {
  const phoneHash = hashOptional(phoneE164);
  if (phoneE164) {
    const phoneUser = await queryOne<{ user_id: string }>(
      `SELECT user_id FROM users WHERE phone_e164 = $1 AND account_status IN ('active','under_review','restricted','suspended')`,
      [phoneE164],
    );
    if (phoneUser) throw new AppError(409, 'PHONE_REGISTERED', 'This phone number is already linked to another TrustRoute account.');
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query<UserRow>(
      `INSERT INTO users
         (identity_id, legal_name, kyc_status, kyc_provider, kyc_doc_hash, kyc_verified_at,
          phone_e164, phone_hash, handle, display_name, account_status, onboarding_complete)
       VALUES ($1, $2, 'verified', 'setu', $3, NOW(), $4, $5, $6, $7, 'active', FALSE)
       RETURNING *`,
      [
        session.identity_id,
        session.legal_name,
        session.doc_hash,
        phoneE164 ?? null,
        phoneHash,
        handle,
        displayName?.trim() || session.legal_name || handle,
      ],
    );
    const user = rows[0]!;

    await client.query(
      `INSERT INTO trust_factors (user_id, factor_type, status, provider, score_delta, verified_at, is_latest)
       VALUES
         ($1, 'govt_id_verified', 'completed', 'setu', 30, NOW(), TRUE),
         ($1, 'liveness_check', 'completed', 'onboarding', 25, NOW(), TRUE),
         ($1, 'device_integrity', 'completed', 'onboarding', 10, NOW(), TRUE)
       ON CONFLICT (user_id, factor_type) WHERE is_latest = TRUE
       DO UPDATE SET
         status = 'completed',
         verified_at = NOW(),
         provider = EXCLUDED.provider,
         score_delta = EXCLUDED.score_delta`,
      [user.user_id],
    );
    if (phoneE164) {
      await client.query(
        `INSERT INTO trust_factors (user_id, factor_type, status, provider, score_delta, verified_at, is_latest)
         VALUES ($1, 'phone_verified', 'completed', 'optional_phone', 15, NOW(), TRUE)
         ON CONFLICT (user_id, factor_type) WHERE is_latest = TRUE
         DO UPDATE SET status = 'completed', verified_at = NOW(), provider = EXCLUDED.provider`,
        [user.user_id],
      );
    }
    await client.query(
      `UPDATE identities
          SET status = 'active',
              status_reason = NULL,
              current_user_id = $2,
              last_handle = $3,
              deleted_at = NULL,
              suspended_at = NULL,
              updated_at = NOW()
        WHERE identity_id = $1`,
      [session.identity_id, user.user_id, user.handle],
    );
    await client.query(
      `UPDATE onboarding_sessions
          SET status = 'completed',
              matched_user_id = $2,
              selected_handle = $3,
              completed_at = NOW(),
              updated_at = NOW()
        WHERE session_id = $1`,
      [session.session_id, user.user_id, user.handle],
    );
    return user;
  });
}

onboardingRouter.post('/complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = completeSchema.parse(req.body);
    const session = await getSession(body.session_id);
    if (!session.identity_id || !session.doc_hash || !session.legal_name) {
      throw new AppError(409, 'IDENTITY_NOT_VERIFIED', 'Verify with DigiLocker before completing setup.');
    }
    if (session.status !== 'liveness_verified' && session.status !== 'matched' && session.status !== 'completed') {
      throw new AppError(409, 'LIVENESS_REQUIRED', 'Complete the face check before finishing setup.');
    }

    if (session.branch === 'banned' || session.branch === 'ousted') {
      throw new AppError(403, 'IDENTITY_BLOCKED', 'This identity cannot be reactivated. You can request a review.');
    }
    if (session.branch === 'suspended') {
      throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended. You can request a review.');
    }

    if (session.branch === 'active' && session.matched_user_id) {
      if (session.purpose !== 'recovery' && session.purpose !== 'pin_reset') {
        throw new AppError(409, 'IDENTITY_EXISTS', 'This identity already has a TrustRoute account. Sign in with your handle and PIN.');
      }
      const user = await queryOne<UserRow>(
        `SELECT * FROM users WHERE user_id = $1 AND account_status IN ('active','under_review','restricted')`,
        [session.matched_user_id],
      );
      if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'We could not find the account for this identity.');
      await query(
        `UPDATE onboarding_sessions SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE session_id = $1`,
        [session.session_id],
      );
      return res.json(await issueAuthResponse(user, true));
    }

    const handle = await validateHandleForSession(session, body.handle ?? session.selected_handle ?? '');
    const displayName = body.display_name?.trim() || session.pending_display_name || session.legal_name || handle;
    const user = await createVerifiedUserFromSession(session, handle, displayName, body.phone_e164);
    await recomputeAndPersist(user.user_id).catch(() => {});
    const fresh = await queryOne<UserRow>(`SELECT * FROM users WHERE user_id = $1`, [user.user_id]);
    res.status(201).json(await issueAuthResponse(fresh ?? user, true));
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /onboarding/finish ─────────────────────────────────────────────────

const finishSchema = z.object({
  referral_code: z.string().max(32).optional(),
});

onboardingRouter.post('/finish', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const body = finishSchema.parse(req.body ?? {});
    const user = await queryOne<UserRow>(`SELECT * FROM users WHERE user_id = $1`, [userId]);
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'Account not found.');
    assertCanAuthenticate(user);
    if (!user.identity_id || user.kyc_status !== 'verified') {
      throw new AppError(403, 'IDENTITY_REQUIRED', 'Government identity verification is required.');
    }
    if (!user.pin_hash) {
      throw new AppError(403, 'PIN_REQUIRED', 'Set a 6-digit login PIN before finishing setup.');
    }

    const factors = await query<{ factor_type: string; status: string }>(
      `SELECT factor_type, status
         FROM trust_factors
        WHERE user_id = $1
          AND factor_type IN ('govt_id_verified','liveness_check')
          AND is_latest = TRUE`,
      [userId],
    );
    const completed = new Set(factors.filter((f) => f.status === 'completed').map((f) => f.factor_type));
    if (!completed.has('govt_id_verified') || !completed.has('liveness_check')) {
      throw new AppError(403, 'ONBOARDING_INCOMPLETE', 'Identity and face verification must be complete.');
    }

    await query(
      `UPDATE users SET onboarding_complete = TRUE, updated_at = NOW() WHERE user_id = $1`,
      [userId],
    );

    let referral: { applied: boolean; referrer_handle?: string } | undefined;
    if (body.referral_code?.trim()) {
      referral = await applyReferralOnOnboardingComplete(userId, body.referral_code);
    }
    await ensureReferralCode(userId);

    const fresh = await queryOne<UserRow>(`SELECT * FROM users WHERE user_id = $1`, [userId]);
    res.json({
      ok: true,
      data: {
        onboarding_complete: true,
        referral,
        user: fresh ? authUserPayload(fresh) : authUserPayload(user),
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /onboarding/appeal ─────────────────────────────────────────────────

const appealSchema = z.object({
  session_id: z.string().uuid().optional(),
  identity_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
  reason: z.string().min(10).max(2000),
  evidence: z.string().max(4000).optional(),
}).refine((v) => v.session_id || v.identity_id || v.user_id, {
  message: 'Provide session_id, identity_id or user_id.',
});

onboardingRouter.post('/appeal', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = appealSchema.parse(req.body);
    let identityId = body.identity_id ?? null;
    let userId = body.user_id ?? null;
    if (body.session_id) {
      const session = await getSession(body.session_id);
      identityId = identityId ?? session.identity_id;
      userId = userId ?? session.matched_user_id;
    }
    if (!identityId && !userId) {
      throw new AppError(400, 'APPEAL_TARGET_MISSING', 'We could not find the account or identity to review.');
    }

    // Healthy / active accounts cannot escalate themselves from the app.
    // Appeals are for restricted/suspended/banned identities (or website-by-handle).
    if (userId) {
      const user = await queryOne<Pick<UserRow, 'account_status'>>(
        `SELECT account_status FROM users WHERE user_id = $1`,
        [userId],
      );
      const status = user?.account_status ?? 'active';
      const appealable = ['under_review', 'restricted', 'suspended', 'banned', 'ousted', 'self_deleted'].includes(status);
      if (!appealable) {
        throw new AppError(
          409,
          'APPEAL_NOT_ALLOWED',
          'Working accounts cannot request a review from the app. If your account is restricted, use trustroute.live/appeal with your @handle.',
        );
      }
    }

    const [appeal] = await query<{
      appeal_id: string;
      status: string;
      created_at: Date;
    }>(
      `INSERT INTO account_appeals (identity_id, user_id, reason, evidence)
       VALUES ($1, $2, $3, $4)
       RETURNING appeal_id, status::text AS status, created_at`,
      [identityId, userId, body.reason.trim(), body.evidence?.trim() || null],
    );
    res.status(201).json({
      ok: true,
      data: {
        appeal_id: appeal.appeal_id,
        status: appeal.status,
        created_at: new Date(appeal.created_at).toISOString(),
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /onboarding/appeal/public ──────────────────────────────────────────
// Website-only: appeal by @handle when the account is restricted (no app login required).

const publicAppealSchema = z.object({
  handle: z.string().min(3).max(30),
  reason: z.string().min(10).max(2000),
  evidence: z.string().max(4000).optional(),
});

onboardingRouter.post('/appeal/public', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = publicAppealSchema.parse(req.body);
    const handle = body.handle.trim().toLowerCase().replace(/^@/, '');
    const user = await queryOne<Pick<UserRow, 'user_id' | 'identity_id' | 'account_status' | 'handle'>>(
      `SELECT user_id, identity_id, account_status, handle FROM users WHERE handle = $1`,
      [handle],
    );
    if (!user) {
      throw new AppError(404, 'HANDLE_NOT_FOUND', 'No TrustRoute account found for that @handle.');
    }
    const appealable = ['under_review', 'restricted', 'suspended', 'banned', 'ousted'].includes(user.account_status);
    if (!appealable) {
      throw new AppError(
        409,
        'APPEAL_NOT_NEEDED',
        'This @handle belongs to an active account. There is nothing to appeal. Contact support if you lost access another way.',
      );
    }

    const open = await queryOne<{ appeal_id: string }>(
      `SELECT appeal_id FROM account_appeals
        WHERE user_id = $1 AND status IN ('submitted','in_review')
        ORDER BY created_at DESC LIMIT 1`,
      [user.user_id],
    );
    if (open) {
      return res.json({
        ok: true,
        data: {
          appeal_id: open.appeal_id,
          status: 'submitted',
          message: 'An appeal is already on file for this @handle. Our team will review it.',
        },
      });
    }

    const [appeal] = await query<{
      appeal_id: string;
      status: string;
      created_at: Date;
    }>(
      `INSERT INTO account_appeals (identity_id, user_id, reason, evidence)
       VALUES ($1, $2, $3, $4)
       RETURNING appeal_id, status::text AS status, created_at`,
      [user.identity_id, user.user_id, body.reason.trim(), body.evidence?.trim() || null],
    );

    res.status(201).json({
      ok: true,
      data: {
        appeal_id: appeal.appeal_id,
        status: appeal.status,
        handle: user.handle,
        created_at: new Date(appeal.created_at).toISOString(),
        message: 'Appeal submitted. We typically review within a few business days.',
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── GET /onboarding/appeal/status ───────────────────────────────────────────

onboardingRouter.get('/appeal/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = z.object({
      session_id: z.string().uuid().optional(),
      identity_id: z.string().uuid().optional(),
      user_id: z.string().uuid().optional(),
    }).parse(req.query);
    let identityId = parsed.identity_id ?? null;
    let userId = parsed.user_id ?? null;
    if (parsed.session_id) {
      const session = await getSession(parsed.session_id);
      identityId = identityId ?? session.identity_id;
      userId = userId ?? session.matched_user_id;
    }
    const appeal = await getLatestAppeal({ userId, identityId });
    res.json({ ok: true, data: { appeal } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});
