/**
 * Masked-calling service (Exotel). Bridges the caller and a phone number through a
 * pooled virtual number without exposing either real number. Billing is computed here
 * in paise; the wallet hold/settle integration lands in P6 (see WALLET note below).
 */
import crypto from 'crypto';
import {
  appError,
  getTelephonyProvider,
  buildPage,
  decodeCursor,
  type PageMeta,
} from '@trustroute/core';
import * as repo from './masked.repository';
import type { MaskedCallRow } from './masked.repository';
import * as usersRepo from '../users/users.repository';
import * as wallet from '../wallet/wallet.service';

const RATE_PAISE_PER_MIN = 100; // ₹1/min
const MAX_MINUTES_HOLD = 10; // reserve up to 10 minutes up front
const HOLD_PAISE = RATE_PAISE_PER_MIN * MAX_MINUTES_HOLD;

/** One-way hash of a phone number so the real number is never stored in the clear. */
function hashNumber(e164: string): string {
  return crypto.createHash('sha256').update(e164.replace(/\s+/g, '')).digest('hex');
}

const costForSeconds = (seconds: number): number => Math.ceil(seconds / 60) * RATE_PAISE_PER_MIN;

function view(c: MaskedCallRow) {
  return {
    callId: c.callId,
    calleeDisplay: c.calleeDisplay,
    virtualNumber: c.virtualNumber,
    status: c.status,
    holdPaise: c.holdPaise,
    billedSeconds: c.billedSeconds,
    costPaise: c.costPaise,
    startedAt: c.startedAt,
    connectedAt: c.connectedAt,
    endedAt: c.endedAt,
    createdAt: c.createdAt,
  };
}

export async function initiate(
  callerId: string,
  input: { calleeNumber: string; calleeDisplay?: string },
) {
  const caller = await usersRepo.findById(callerId);
  if (!caller) throw appError('USER_INACTIVE');

  // Reserve funds up front (throws INSUFFICIENT_BALANCE). Released/settled on end.
  const landingToken = crypto.randomBytes(12).toString('base64url');
  await wallet.hold(callerId, HOLD_PAISE, `mhold-${landingToken}`);

  let virtualNumber: string | null;
  try {
    virtualNumber = await repo.leaseVirtualNumber(landingToken);
  } catch (err) {
    await wallet.settleHold(callerId, HOLD_PAISE, 0, `mrel-fail-${landingToken}`); // refund the hold
    throw err;
  }
  if (!virtualNumber) {
    await wallet.settleHold(callerId, HOLD_PAISE, 0, `mrel-fail-${landingToken}`); // refund the hold
    throw appError('SERVICE_UNAVAILABLE', 'No masked numbers are available right now.');
  }

  const telephony = getTelephonyProvider();
  const handle = await telephony.placeMaskedCall({
    callerNumber: caller.phoneE164 ?? virtualNumber,
    calleeNumber: input.calleeNumber,
    virtualNumber,
  });

  const call = await repo.createMaskedCall({
    callerId,
    calleeNumberHash: hashNumber(input.calleeNumber),
    calleeDisplay: input.calleeDisplay ?? null,
    virtualNumber,
    providerRef: handle.providerRef,
    landingToken,
    holdPaise: HOLD_PAISE,
  });

  return { call: view(call), virtualNumber, providerStatus: handle.status, mock: telephony.mock };
}

/**
 * Provider-driven "connected" transition (Exotel passthru/callback). Exposed as a
 * service call so the webhook handler (or a mock caller) can advance the state.
 */
export async function markConnected(callerId: string, callId: string) {
  const call = await repo.findForCaller(callId, callerId);
  if (!call) throw appError('CALL_NOT_FOUND');
  const updated = await repo.markConnected(callId);
  if (!updated) throw appError('CALL_NOT_ALLOWED', 'This call cannot be connected.');
  return { call: view(updated) };
}

export async function end(callerId: string, callId: string) {
  const call = await repo.findForCaller(callId, callerId);
  if (!call) throw appError('CALL_NOT_FOUND');
  if (call.status === 'ended') return { call: view(call) };

  // Bill from connect time (or start time if it never formally connected).
  const from = call.connectedAt ?? call.startedAt ?? call.createdAt;
  const billedSeconds = Math.max(0, Math.round((Date.now() - from.getTime()) / 1000));
  const costPaise = call.connectedAt ? costForSeconds(billedSeconds) : 0;

  const telephony = getTelephonyProvider();
  if (call.providerRef) await telephony.endCall(call.providerRef);

  const updated = await repo.markEnded(callId, billedSeconds, costPaise);
  // Settle: the hold already removed HOLD_PAISE; refund the unused remainder so the net
  // debit equals the actual cost. Idempotent on the call id.
  await wallet.settleHold(callerId, call.holdPaise, costPaise, `mrel-${callId}`);
  return { call: view(updated ?? call) };
}

export async function history(
  callerId: string,
  limit: number,
  cursor?: string,
): Promise<{ items: ReturnType<typeof view>[]; meta: PageMeta }> {
  const rows = await repo.listForCaller(callerId, limit, decodeCursor(cursor));
  const page = buildPage(rows, limit, (r) => ({ t: r.createdAt.toISOString(), id: r.callId }));
  return { items: page.items.map(view), meta: page.meta };
}

export async function get(callerId: string, callId: string) {
  const call = await repo.findForCaller(callId, callerId);
  if (!call) throw appError('CALL_NOT_FOUND');
  return { call: view(call) };
}

export async function report(
  reporterId: string,
  input: { virtualNumber?: string; callRef?: string; reason?: string },
) {
  await repo.createReport({
    virtualNumber: input.virtualNumber ?? null,
    callRef: input.callRef ?? null,
    reason: input.reason ?? 'unwanted',
    reporterHash: crypto.createHash('sha256').update(reporterId).digest('hex'),
  });
  return { reported: true };
}
