/**
 * Legacy `/numbers/*` compatibility → v2 shadow-trust tables. The dialer records call
 * outcomes against non-TrustRoute numbers (`observe`) and looks up a number's crowd
 * reputation before/after a call (`caller-info`, `shadow`). Raw numbers are never stored —
 * only their SHA-256 hash. There is no v2 service for this yet, so we read/write the
 * `dialer_observations` + `shadow_numbers` tables directly.
 */
import crypto from 'node:crypto';
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, requireAuth, apiLimiter, db, dialerObservations, shadowNumbers, users, eq, sql } from '@trustroute/core';

const router = Router();
router.use(requireAuth);
const uid = (req: { user?: { sub: string } }) => req.user!.sub;

/** Accept a pre-hashed value or hash a raw number (never persist the raw number). */
function phoneHashOf(body: Record<string, unknown>): string | null {
  if (typeof body.phoneHash === 'string' && body.phoneHash) return body.phoneHash;
  const num = body.number ?? body.phoneE164;
  if (typeof num === 'string' && num) return crypto.createHash('sha256').update(num.replace(/\s+/g, '')).digest('hex');
  return null;
}

const VALID_OUTCOMES = new Set([
  'picked_up', 'declined', 'blocked', 'saved', 'hung_up_fast',
  'incoming_accepted', 'incoming_declined', 'incoming_missed', 'incoming_blocked',
  'outgoing_answered', 'outgoing_missed', 'outgoing_declined',
]);

router.post('/observe', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const phoneHash = phoneHashOf(body);
  const outcome = String(body.outcome ?? '');
  if (!phoneHash || !VALID_OUTCOMES.has(outcome)) return sendOk(res, { recorded: false });
  await db
    .insert(dialerObservations)
    .values({
      observerId: uid(req),
      phoneHash,
      outcome,
      direction: body.direction === 'incoming' || body.direction === 'outgoing' ? body.direction : null,
      isContact: Boolean(body.isContact),
      weight: typeof body.weight === 'number' ? String(Math.max(0, Math.min(1, body.weight))) : '1.000',
      durationS: typeof body.durationS === 'number' ? body.durationS : null,
    })
    .onConflictDoNothing();
  sendOk(res, { recorded: true });
}));

async function reputation(phoneHash: string) {
  const [shadow] = await db.select().from(shadowNumbers).where(eq(shadowNumbers.phoneHash, phoneHash)).limit(1);
  const [known] = await db.select({ handle: users.handle, trustTier: users.trustTier }).from(users).where(eq(users.phoneHash, phoneHash)).limit(1);
  return {
    phoneHash,
    isTrustrouteUser: Boolean(known),
    knownUser: known ?? null,
    shadowScore: shadow?.shadowScore ?? null,
    observationCount: shadow?.observationCount ?? 0,
    reputation: shadow ? { pickRate: shadow.pickRate, blockRate: shadow.blockRate, saveRate: shadow.saveRate } : null,
  };
}
router.post('/caller-info', asyncHandler(async (req, res) => {
  const phoneHash = phoneHashOf((req.body ?? {}) as Record<string, unknown>);
  if (!phoneHash) return sendOk(res, { phoneHash: null, isTrustrouteUser: false, shadowScore: null });
  sendOk(res, await reputation(phoneHash));
}));
router.post('/shadow', asyncHandler(async (req, res) => {
  const phoneHash = phoneHashOf((req.body ?? {}) as Record<string, unknown>);
  if (!phoneHash) return sendOk(res, { shadowScore: null });
  const [shadow] = phoneHash ? await db.select().from(shadowNumbers).where(eq(shadowNumbers.phoneHash, phoneHash)).limit(1) : [];
  sendOk(res, { phoneHash, shadowScore: shadow?.shadowScore ?? null, observationCount: shadow?.observationCount ?? 0 });
}));

export function register(app: Express): void {
  app.use('/numbers', apiLimiter, router);
}
