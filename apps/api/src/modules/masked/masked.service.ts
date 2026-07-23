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

const DAILY_CALL_CAP = 20;

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
/**
 * Pre-flight check the app runs before showing the dial screen: can this caller
 * actually place the call, and what will it cost? Answering here means the user
 * sees "top up to call" instead of a failed call that has already taken a hold.
 */
export async function precheck(callerId: string, _number: string) {
  const caller = await usersRepo.findById(callerId);
  if (!caller) throw appError('USER_INACTIVE');

  const [balance, usedToday, activeNumber] = await Promise.all([
    wallet.getBalance(callerId),
    repo.countToday(callerId),
    repo.activeVirtualNumberFor(callerId),
  ]);

  const balancePaise = balance.balancePaise ?? 0;
  const dailyCapLeft = Math.max(0, DAILY_CALL_CAP - usedToday);
  const estMinutes = Math.floor(balancePaise / RATE_PAISE_PER_MIN);

  let allowed = true;
  let reason: string | null = null;
  let reasonCode: string | null = null;

  if (dailyCapLeft <= 0) {
    allowed = false;
    reasonCode = 'DAILY_CAP_REACHED';
    reason = `You have used all ${DAILY_CALL_CAP} masked calls for today.`;
  } else if (balancePaise < RATE_PAISE_PER_MIN) {
    allowed = false;
    reasonCode = 'INSUFFICIENT_BALANCE';
    reason = 'Add credit to place a masked call.';
  }

  return {
    allowed,
    reason,
    reasonCode,
    estRatePaise: RATE_PAISE_PER_MIN,
    balancePaise,
    estMinutes,
    dailyCapLeft,
    maskedNumber: activeNumber,
  };
}

/**
 * Forward a keypad tone to the live call (IVR menus, extensions). Only the
 * caller on a connected call may send one.
 */
export async function sendDtmf(callerId: string, callId: string, digit: string) {
  const call = await repo.findForCaller(callId, callerId);
  if (!call) throw appError('NOT_FOUND', 'Call not found.');
  if (call.status !== 'connected') {
    throw appError('BAD_REQUEST', 'Tones can only be sent on a connected call.');
  }
  const telephony = getTelephonyProvider();
  if (!call.providerRef || typeof telephony.sendDtmf !== 'function') {
    // No provider support (or a mock): accept the tone so the UI stays
    // responsive, but say plainly that it was not delivered.
    return { sent: false, delivered: false, digit };
  }
  await telephony.sendDtmf(call.providerRef, digit);
  return { sent: true, delivered: true, digit };
}

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
