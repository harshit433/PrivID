/**
 * Masked-calling request DTOs.
 */
import { z } from 'zod';
import { paginationQuery } from '@trustroute/core';

const e164 = z.string().trim().regex(/^\+?[1-9]\d{7,14}$/, 'Enter a valid phone number.');

export const initiateBody = z.object({
  calleeNumber: e164,
  calleeDisplay: z.string().trim().max(80).optional(),
});

export const reportBody = z.object({
  virtualNumber: z.string().trim().max(20).optional(),
  callRef: z.string().trim().max(120).optional(),
  reason: z.string().trim().max(120).optional(),
});

export const listQuery = paginationQuery;
export const callIdParam = z.object({ callId: z.string().uuid() });

/** Pre-flight check before placing a masked call: can this caller afford it? */
export const precheckBody = z.object({
  number: e164,
});

/** In-call keypad tone, forwarded to the telephony provider. */
export const dtmfBody = z.object({
  digit: z.string().trim().regex(/^[0-9*#]$/, 'Digit must be 0-9, * or #.'),
});
