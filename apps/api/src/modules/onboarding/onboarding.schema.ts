/**
 * Onboarding request DTOs. The signup/recovery state machine is driven step-by-step;
 * each step carries the session id it advances (except `start`, which mints one).
 */
import { z } from 'zod';

const handleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._]{3,30}$/, 'Handles use 3–30 letters, numbers, dots or underscores.');

const pinSchema = z.string().regex(/^\d{6}$/, 'PIN must be exactly 6 digits.');
const sessionId = z.string().uuid();

export const startBody = z.object({
  purpose: z.enum(['signup', 'recovery', 'pin_reset']).default('signup'),
  deviceFingerprintHash: z.string().max(256).optional(),
  platform: z.enum(['ios', 'android']).optional(),
  integrity: z.record(z.unknown()).optional(),
});

export const sessionBody = z.object({ sessionId });

export const digilockerCallbackBody = z.object({
  sessionId,
  providerRef: z.string().max(256).optional(),
});

export const livenessCompleteBody = z.object({
  sessionId,
  selfieB64: z.string().min(1, 'A selfie image is required.'),
});

export const checkHandleBody = z.object({ handle: handleSchema });

export const sessionHandleCheckBody = z.object({
  sessionId,
  handle: z.string().min(1),
});

/** Query strings stay snake_case — only JSON bodies are camelCased. */
export const handleCheckQuery = z.object({
  session_id: sessionId,
  handle: z.string().min(1),
});

export const sessionIdQuery = z.object({
  session_id: sessionId,
});

export const setHandleBody = z.object({
  sessionId,
  handle: handleSchema,
  displayName: z.string().trim().min(1).max(80).optional(),
});

export const completeBody = z.object({
  sessionId,
  pin: pinSchema.optional(),
  displayName: z.string().trim().min(1).max(80).optional(),
  handle: handleSchema.optional(),
});

/** Final signup step (authenticated). Body may be empty — referral is optional. */
export const finishBody = z.object({
  referralCode: z.string().trim().min(1).max(32).optional(),
});

/**
 * Appeal submission. Unauthenticated — a suspended/banned/ousted user has no
 * token, so the subject comes from the onboarding session (preferred) or an
 * explicitly supplied identity/user id.
 */
export const appealBody = z
  .object({
    sessionId: z.string().uuid().optional(),
    identityId: z.string().uuid().optional(),
    userId: z.string().uuid().optional(),
    reason: z.string().trim().min(20).max(2000),
    evidence: z.string().trim().max(4000).optional(),
  })
  .refine((b) => Boolean(b.sessionId || b.identityId || b.userId), {
    message: 'Provide a session, identity or user id.',
    path: ['sessionId'],
  });

/**
 * Query keys stay snake_case: only request *bodies* are camel-cased by the app
 * middleware, so query schemas here (see sessionIdQuery, handleCheckQuery)
 * match the wire format directly.
 */
export const appealStatusQuery = z.object({
  session_id: z.string().uuid().optional(),
  identity_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
});
