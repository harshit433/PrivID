import crypto from 'crypto';
import { query, queryOne } from '@trustroute/shared';
import { AppError } from '../middleware/errorHandler';
import {
  getMaskedDailyFreeCalls,
  getMaskedHoldMinutes,
  getPerMinuteRatePaise,
  isMaskedCallingEnabled,
  isTelephonyUp,
  paiseToMinutes,
} from './appConfig';
import { hashPhoneNumber, maskPhoneNumber, normalizePhoneNumber } from './phoneHash';
import {
  estimateCostPaise,
  estimateHoldPaise,
  getWalletBalancePaise,
  getWalletSummary,
  placeHold,
  releaseHold,
  settleMaskedCall,
} from './wallet';
import { getTelephonyProvider } from './telephony';
import { effectiveAccountStatus } from './accountState';
import type { AccountStatus } from '@trustroute/shared';

const MASKED_COOLDOWN_MS = 2 * 60 * 1000; // 2 min between masked calls

export interface MaskedPrecheckResult {
  allowed: boolean;
  reason?: string;
  reason_code?: string;
  est_rate_paise: number;
  balance_paise: number;
  est_minutes: number;
  daily_cap_left: number;
  masked_number?: string;
}

async function getCallerPhone(userId: string): Promise<string> {
  const user = await queryOne<{ phone_e164: string | null }>(
    `SELECT phone_e164 FROM users WHERE user_id = $1`,
    [userId],
  );
  if (!user?.phone_e164) {
    throw new AppError(400, 'PHONE_REQUIRED', 'Add a verified phone number to make private calls.');
  }
  return user.phone_e164;
}

async function getTrustScore(userId: string): Promise<number> {
  const row = await queryOne<{ trust_score: number }>(
    `SELECT trust_score FROM users WHERE user_id = $1`,
    [userId],
  );
  return row?.trust_score ?? 0;
}

async function getLastMaskedCallAt(userId: string): Promise<Date | null> {
  const row = await queryOne<{ created_at: Date }>(
    `SELECT created_at FROM masked_calls
     WHERE caller_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  return row?.created_at ?? null;
}

async function countMaskedCallsToday(userId: string): Promise<number> {
  const row = await queryOne<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM masked_calls
     WHERE caller_id = $1
       AND created_at > date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata')
       AND status NOT IN ('failed', 'cancelled')`,
    [userId],
  );
  return parseInt(row?.cnt ?? '0', 10);
}

async function assignVirtualNumber(): Promise<string> {
  const row = await queryOne<{ virtual_number: string }>(
    `UPDATE number_pool
     SET assigned_ref = gen_random_uuid()::text, updated_at = NOW()
     WHERE virtual_number = (
       SELECT virtual_number FROM number_pool
       WHERE status = 'active'
       ORDER BY updated_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING virtual_number`,
  );
  if (!row) {
    throw new AppError(503, 'TELEPHONY_UNAVAILABLE', 'No virtual numbers available.');
  }
  return row.virtual_number;
}

function landingToken(callId: string): string {
  return crypto.createHash('sha256').update(callId).digest('hex').slice(0, 16);
}

async function evaluateGating(userId: string, balancePaise: number, ratePaise: number): Promise<{
  allowed: boolean;
  reason?: string;
  reason_code?: string;
  daily_cap_left: number;
}> {
  const [enabled, telephonyUp, userRow, trustScore, dailyFree, usedToday, lastAt] =
    await Promise.all([
      isMaskedCallingEnabled(),
      isTelephonyUp(),
      queryOne<{
        account_status: string | null;
        is_active: boolean;
        is_under_review: boolean;
        call_restriction_until: Date | null;
      }>(`SELECT account_status, is_active, is_under_review, call_restriction_until FROM users WHERE user_id = $1`, [userId]),
      getTrustScore(userId),
      getMaskedDailyFreeCalls(),
      countMaskedCallsToday(userId),
      getLastMaskedCallAt(userId),
    ]);

  const accountState = userRow
    ? effectiveAccountStatus({
        account_status: (userRow.account_status as AccountStatus | null) ?? 'active',
        is_active: userRow.is_active,
        is_under_review: userRow.is_under_review,
        call_restriction_until: userRow.call_restriction_until,
      })
    : 'active';

  const dailyLeft = Math.max(0, dailyFree - usedToday);

  if (!enabled || !telephonyUp) {
    return { allowed: false, reason_code: 'TELEPHONY_DOWN', reason: 'Masked calling is briefly unavailable.', daily_cap_left: dailyLeft };
  }
  if (accountState === 'restricted' || accountState === 'suspended') {
    return { allowed: false, reason_code: 'ACCOUNT_RESTRICTED', reason: 'Your account cannot make private calls right now.', daily_cap_left: dailyLeft };
  }
  if (trustScore < 20) {
    return { allowed: false, reason_code: 'TRUST_TOO_LOW', reason: 'Masked calling unlocks as your account builds trust.', daily_cap_left: dailyLeft };
  }
  if (lastAt && Date.now() - new Date(lastAt).getTime() < MASKED_COOLDOWN_MS) {
    const mins = Math.ceil((MASKED_COOLDOWN_MS - (Date.now() - new Date(lastAt).getTime())) / 60_000);
    return { allowed: false, reason_code: 'COOLDOWN_ACTIVE', reason: `Please wait ${mins} min before another private call.`, daily_cap_left: dailyLeft };
  }
  if (usedToday >= dailyFree && balancePaise < ratePaise) {
    return { allowed: false, reason_code: 'DAILY_CAP', reason: "You've used today's private-call limit.", daily_cap_left: 0 };
  }
  if (balancePaise < ratePaise && usedToday >= dailyFree) {
    return { allowed: false, reason_code: 'INSUFFICIENT_BALANCE', reason: 'Add balance to make private calls.', daily_cap_left: dailyLeft };
  }

  return { allowed: true, daily_cap_left: dailyLeft };
}

export async function maskedPrecheck(userId: string, number: string): Promise<MaskedPrecheckResult> {
  const normalized = normalizePhoneNumber(number);
  if (normalized.replace(/\D/g, '').length < 10) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Enter a valid phone number.');
  }

  const rate = await getPerMinuteRatePaise();
  const balance = await getWalletBalancePaise(userId);
  const gate = await evaluateGating(userId, balance, rate);

  return {
    allowed: gate.allowed,
    reason: gate.reason,
    reason_code: gate.reason_code,
    est_rate_paise: rate,
    balance_paise: balance,
    est_minutes: paiseToMinutes(balance, rate),
    daily_cap_left: gate.daily_cap_left,
    masked_number: maskPhoneNumber(normalized),
  };
}

export async function initiateMaskedCall(
  userId: string,
  number: string,
  webhookBaseUrl: string,
): Promise<{
  masked_call_id: string;
  status: string;
  virtual_number: string;
  landing_token: string;
  hold_paise: number;
}> {
  const pre = await maskedPrecheck(userId, number);
  if (!pre.allowed) {
    throw new AppError(403, pre.reason_code ?? 'MASKED_NOT_ALLOWED', pre.reason ?? 'Cannot place private call.');
  }

  const normalized = normalizePhoneNumber(number);
  const calleeHash = hashPhoneNumber(normalized);
  const rate = pre.est_rate_paise;
  const holdMinutes = await getMaskedHoldMinutes();
  const holdPaise = estimateHoldPaise(holdMinutes, rate);

  const balance = await getWalletBalancePaise(userId);
  if (balance < holdPaise && pre.daily_cap_left <= 0) {
    throw new AppError(402, 'INSUFFICIENT_BALANCE', 'Add balance to make private calls.');
  }

  const callerPhone = await getCallerPhone(userId);
  const virtualNumber = await assignVirtualNumber();
  const callId = crypto.randomUUID();
  const token = landingToken(callId);

  await query(
    `INSERT INTO masked_calls
       (call_id, caller_id, callee_number_hash, callee_display, virtual_number, landing_token, status, hold_paise)
     VALUES ($1, $2, $3, $4, $5, $6, 'placing', $7)`,
    [callId, userId, calleeHash, maskPhoneNumber(normalized), virtualNumber, token, holdPaise],
  );

  // Place wallet hold (skip if daily free and zero hold policy — still hold min 1 min for metering safety)
  const effectiveHold = Math.min(holdPaise, balance);
  if (effectiveHold > 0) {
    await placeHold(userId, effectiveHold, `${callId}:hold`);
    await query(`UPDATE masked_calls SET hold_paise = $2 WHERE call_id = $1`, [callId, effectiveHold]);
  }

  const provider = getTelephonyProvider();
  const callbackUrl = `${webhookBaseUrl.replace(/\/$/, '')}/telephony/webhook`;
  const bridge = await provider.initiateBridge({
    callerPhone,
    calleePhone: normalized,
    virtualNumber,
    callbackUrl,
  });

  await query(
    `UPDATE masked_calls SET provider_ref = $2, status = 'ringing_caller' WHERE call_id = $1`,
    [callId, bridge.provider_ref],
  );

  return {
    masked_call_id: callId,
    status: 'ringing_caller',
    virtual_number: virtualNumber,
    landing_token: token,
    hold_paise: effectiveHold,
  };
}

export async function getMaskedCall(callId: string, userId?: string) {
  const row = await queryOne<{
    call_id: string;
    caller_id: string;
    callee_display: string | null;
    virtual_number: string | null;
    status: string;
    hold_paise: number;
    billed_seconds: number;
    cost_paise: number;
    started_at: Date | null;
    connected_at: Date | null;
    ended_at: Date | null;
    created_at: Date;
    landing_token: string | null;
  }>(
    `SELECT call_id, caller_id, callee_display, virtual_number, status,
            hold_paise, billed_seconds, cost_paise,
            started_at, connected_at, ended_at, created_at, landing_token
     FROM masked_calls WHERE call_id = $1`,
    [callId],
  );
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Call not found.');
  if (userId && row.caller_id !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'Not your call.');
  }

  const rate = await getPerMinuteRatePaise();
  const wallet = userId ? await getWalletSummary(userId) : null;

  return {
    ...row,
    est_rate_paise: rate,
    balance_paise: wallet?.balance_paise,
    est_minutes: wallet?.minutes,
    spent_paise: row.cost_paise,
    duration_sec: row.billed_seconds,
  };
}

export async function cancelMaskedCall(callId: string, userId: string): Promise<{ cancelled: boolean }> {
  const call = await queryOne<{
    call_id: string;
    caller_id: string;
    hold_paise: number;
    status: string;
  }>(
    `SELECT call_id, caller_id, hold_paise, status FROM masked_calls WHERE call_id = $1`,
    [callId],
  );
  if (!call) throw new AppError(404, 'NOT_FOUND', 'Call not found.');
  if (call.caller_id !== userId) throw new AppError(403, 'FORBIDDEN', 'Not your call.');
  if (['ended', 'failed', 'cancelled'].includes(call.status)) {
    return { cancelled: true };
  }

  await query(
    `UPDATE masked_calls SET status = 'cancelled', ended_at = NOW() WHERE call_id = $1`,
    [callId],
  );

  if (call.hold_paise > 0) {
    const { releaseHold } = await import('./wallet');
    await releaseHold(userId, call.hold_paise, `${callId}:hold`).catch(() => {});
  }

  const { maybeTriggerAutoRecharge } = await import('./wallet');
  void maybeTriggerAutoRecharge(userId);

  return { cancelled: true };
}

export async function sendMaskedCallDtmf(
  callId: string,
  userId: string,
  digit: string,
): Promise<{ sent: boolean }> {
  if (!/^[0-9*#]$/.test(digit)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid keypad digit.');
  }
  const call = await queryOne<{ caller_id: string; provider_ref: string | null; status: string }>(
    `SELECT caller_id, provider_ref, status FROM masked_calls WHERE call_id = $1`,
    [callId],
  );
  if (!call) throw new AppError(404, 'NOT_FOUND', 'Call not found.');
  if (call.caller_id !== userId) throw new AppError(403, 'FORBIDDEN', 'Not your call.');
  if (call.status !== 'connected') {
    throw new AppError(400, 'CALL_NOT_ACTIVE', 'Keypad is available once the call connects.');
  }
  if (!call.provider_ref) {
    throw new AppError(503, 'TELEPHONY_UNAVAILABLE', 'Call leg not ready for keypad.');
  }
  const provider = getTelephonyProvider();
  if (!provider.sendDtmf) {
    throw new AppError(503, 'TELEPHONY_UNAVAILABLE', 'Keypad not supported for this provider.');
  }
  await provider.sendDtmf(call.provider_ref, digit);
  return { sent: true };
}

export async function listRecentMaskedCalls(userId: string, limit = 20): Promise<Array<{
  call_id: string;
  callee_display: string | null;
  status: string;
  billed_seconds: number;
  cost_paise: number;
  created_at: string;
}>> {
  const rows = await query<{
    call_id: string;
    callee_display: string | null;
    status: string;
    billed_seconds: number;
    cost_paise: number;
    created_at: Date;
  }>(
    `SELECT call_id, callee_display, status, billed_seconds, cost_paise, created_at
     FROM masked_calls WHERE caller_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => ({
    ...r,
    created_at: new Date(r.created_at).toISOString(),
  }));
}

export async function processTelephonyEvent(event: {
  provider_ref: string;
  event: string;
  billed_seconds?: number;
  failure_reason?: string;
}): Promise<void> {
  const call = await queryOne<{
    call_id: string;
    caller_id: string;
    hold_paise: number;
    status: string;
  }>(
    `SELECT call_id, caller_id, hold_paise, status FROM masked_calls WHERE provider_ref = $1`,
    [event.provider_ref],
  );
  if (!call) return;

  const rate = await getPerMinuteRatePaise();

  switch (event.event) {
    case 'leg_a_ringing':
      await query(`UPDATE masked_calls SET status = 'ringing_caller' WHERE call_id = $1`, [call.call_id]);
      break;
    case 'leg_a_answered':
      await query(`UPDATE masked_calls SET status = 'ringing_callee', started_at = COALESCE(started_at, NOW()) WHERE call_id = $1`, [call.call_id]);
      break;
    case 'leg_b_ringing':
      await query(`UPDATE masked_calls SET status = 'ringing_callee' WHERE call_id = $1`, [call.call_id]);
      break;
    case 'connected':
      await query(`UPDATE masked_calls SET status = 'connected', connected_at = NOW() WHERE call_id = $1`, [call.call_id]);
      break;
    case 'ended': {
      const billed = event.billed_seconds ?? 0;
      const cost = estimateCostPaise(billed, rate);
      await query(
        `UPDATE masked_calls
         SET status = 'ended', billed_seconds = $2, cost_paise = $3, ended_at = NOW()
         WHERE call_id = $1`,
        [call.call_id, billed, cost],
      );
      await settleMaskedCall(call.caller_id, call.call_id, call.hold_paise, cost, billed);
      await query(`UPDATE number_pool SET assigned_ref = NULL, updated_at = NOW() WHERE assigned_ref IS NOT NULL`);
      break;
    }
    case 'failed':
    case 'cancelled': {
      await query(
        `UPDATE masked_calls SET status = 'failed', ended_at = NOW() WHERE call_id = $1`,
        [call.call_id],
      );
      if (call.hold_paise > 0) {
        await releaseHold(call.caller_id, call.hold_paise, call.call_id);
      }
      break;
    }
    default:
      break;
  }
}

export async function getLandingByToken(token: string) {
  const row = await queryOne<{
    call_id: string;
    virtual_number: string | null;
    callee_display: string | null;
    created_at: Date;
  }>(
    `SELECT call_id, virtual_number, callee_display, created_at
     FROM masked_calls WHERE landing_token = $1`,
    [token],
  );
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Link not found.');
  return {
    token,
    virtual_number: row.virtual_number,
    callee_display: row.callee_display,
    called_at: new Date(row.created_at).toISOString(),
  };
}

export async function reportUnwantedCall(token: string, reporterHash?: string) {
  const landing = await getLandingByToken(token);
  await query(
    `INSERT INTO masked_call_reports (virtual_number, call_ref, reason, reporter_hash)
     VALUES ($1, $2, 'unwanted', $3)`,
    [landing.virtual_number, token, reporterHash ?? null],
  );
  return { ok: true };
}
