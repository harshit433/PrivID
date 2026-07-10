/**
 * Time-series simulation — event generation + persistence for one virtual window.
 *
 * Produces the messy call/block/connection churn for a slice of virtual time and
 * writes it to Postgres with backdated timestamps. Note: `connections` has a
 * BEFORE UPDATE trigger that stamps updated_at=NOW(), so blocks are written as
 * delete+insert (INSERT does not fire the trigger) to preserve the virtual block
 * time that `blocked_by_7d/30d` windows depend on.
 */

import { randomUUID } from 'crypto';
import { query } from '@trustroute/shared';
import { Rng } from './rng';
import type { SimAccount } from './personas';
import { behaviourAt, diurnalWeight } from './personas';
import type { SimGraph } from './graph';

interface CallRow {
  caller_id: string; callee_id: string; call_type: 'direct' | 'reachability';
  status: 'ended' | 'missed' | 'declined' | 'failed';
  duration_seconds: number | null; created_at: string; ended_at: string | null; channel_id: string | null;
}
interface BlockRow { owner: string; contact: string; ts: string; reason: string; }
interface UsageRow { channel_id: string; caller_id: string; action: string; ts: string; }
interface BehaviorRow { user_id: string; event_type: string; target_user_id: string | null; ts: string; }

export interface SimState {
  unwanted: Map<string, number>;
  blocked: Set<string>;                 // `${owner}|${contact}`
  channelOf: Map<string, string>;       // calleeId -> channel_id
  newChannels: { channel_id: string; owner_id: string }[];
  dailyUnknown: Map<string, number>;    // `${caller}|${callee}|${day}` -> attempts
  personalSchedule: { day: number; owner: string; contact: string }[];
  personalApplied: Set<number>;
  totalCalls: number;
}

const DAILY_UNKNOWN_CAP = 3; // mirrors reachability channel daily_limit (frequency handling)

export function initState(rng: Rng, accounts: SimAccount[], graph: SimGraph, virtualDays: number): SimState {
  const personalSchedule: { day: number; owner: string; contact: string }[] = [];
  for (const a of accounts) {
    if (a.persona !== 'personal_blocker') continue;
    const contacts = graph.contacts.get(a.user_id) ?? [];
    const blockers = rng.shuffle(contacts.map(c => c.id)).slice(0, rng.int(2, 3));
    for (const owner of blockers) {
      personalSchedule.push({ day: rng.int(2, Math.max(3, virtualDays - 2)), owner, contact: a.user_id });
    }
  }
  return {
    unwanted: new Map(), blocked: new Set(), channelOf: new Map(), newChannels: [],
    dailyUnknown: new Map(), personalSchedule, personalApplied: new Set(), totalCalls: 0,
  };
}

export interface WindowResult {
  calls: CallRow[]; blocks: BlockRow[]; usage: UsageRow[]; behavior: BehaviorRow[]; affected: Set<string>;
}

/** Generate all events for one virtual window [startTs, endTs] on virtual day `dayInt`. */
export function generateWindow(
  rng: Rng, accounts: SimAccount[], graph: SimGraph, state: SimState,
  dayInt: number, hourOfDay: number, windowHours: number,
  startTs: Date, endTs: Date,
): WindowResult {
  const res: WindowResult = { calls: [], blocks: [], usage: [], behavior: [], affected: new Set() };
  const spanMs = endTs.getTime() - startTs.getTime();
  const tsAt = (frac: number) => new Date(startTs.getTime() + frac * spanMs).toISOString();

  // ── Scheduled personal-reason blocks (false-positive scenario) ──────────────
  for (let k = 0; k < state.personalSchedule.length; k++) {
    if (state.personalApplied.has(k)) continue;
    const ev = state.personalSchedule[k];
    if (ev.day > dayInt) continue;
    const key = `${ev.owner}|${ev.contact}`;
    if (!state.blocked.has(key)) {
      state.blocked.add(key);
      res.blocks.push({ owner: ev.owner, contact: ev.contact, ts: tsAt(rng.next()), reason: 'personal' });
      res.behavior.push({ user_id: ev.owner, event_type: 'personal_block', target_user_id: ev.contact, ts: tsAt(0.5) });
      res.affected.add(ev.contact);
    }
    state.personalApplied.add(k);
  }

  // ── Per-account outgoing calls this window ──────────────────────────────────
  for (const a of accounts) {
    const beh = behaviourAt(a, dayInt);
    const dayFraction = windowHours / 24;
    const diurnal = diurnalWeight(hourOfDay, a.activePeakHour);
    const lambda = beh.callsPerDay * dayFraction * diurnal;
    let nCalls = rng.poisson(lambda);
    if (nCalls <= 0) continue;
    nCalls = Math.min(nCalls, 80); // safety cap per window

    for (let c = 0; c < nCalls; c++) {
      const callee = chooseCallee(rng, a, beh.mode, beh.unknownRate, graph);
      if (!callee || callee === a.user_id) continue;
      const b = graph.byId.get(callee);
      if (!b) continue;

      // Callee already blocked caller → call can't go through.
      if (state.blocked.has(`${callee}|${a.user_id}`)) continue;

      const isContact = (graph.contacts.get(a.user_id) ?? []).some(x => x.id === callee);
      const isCold = !isContact;
      const frac = rng.next();
      const created = tsAt(frac);

      // Reachability + daily frequency cap for cold (unknown) calls.
      let callType: 'direct' | 'reachability' = 'direct';
      let channelId: string | null = null;
      if (isCold) {
        callType = 'reachability';
        channelId = ensureChannel(state, callee);
        const capKey = `${a.user_id}|${callee}|${dayInt}`;
        const used = state.dailyUnknown.get(capKey) ?? 0;
        state.dailyUnknown.set(capKey, used + 1);
        if (used >= DAILY_UNKNOWN_CAP) {
          res.calls.push({ caller_id: a.user_id, callee_id: callee, call_type: 'reachability', status: 'failed', duration_seconds: null, created_at: created, ended_at: null, channel_id: channelId });
          res.usage.push({ channel_id: channelId, caller_id: a.user_id, action: 'limit_hit', ts: created });
          res.affected.add(a.user_id); res.affected.add(callee);
          continue;
        }
        res.usage.push({ channel_id: channelId, caller_id: a.user_id, action: 'call_attempted', ts: created });
      }

      // Answer probability.
      const unwanted = beh.mode !== 'normal' || isCold;
      let pAnswer = b.answerIncoming;
      const trusted = (graph.contacts.get(callee) ?? []).find(x => x.id === a.user_id && x.type === 'trusted');
      if (trusted) pAnswer = Math.min(0.98, pAnswer * 1.25);
      if (unwanted) pAnswer *= 0.25;

      let status: CallRow['status'];
      let duration: number | null = null;
      let endedAt: string | null = null;
      if (rng.next() < pAnswer) {
        status = 'ended';
        duration = beh.mode === 'normal' ? rng.int(25, 600) : rng.int(2, 18);
        endedAt = new Date(new Date(created).getTime() + duration * 1000).toISOString();
      } else {
        status = unwanted && rng.bool(0.5) ? 'declined' : 'missed';
      }
      res.calls.push({ caller_id: a.user_id, callee_id: callee, call_type: callType, status, duration_seconds: duration, created_at: created, ended_at: endedAt, channel_id: channelId });
      if (channelId && status === 'ended') res.usage.push({ channel_id: channelId, caller_id: a.user_id, action: 'call_connected', ts: created });
      res.affected.add(a.user_id); res.affected.add(callee);

      // Blocking: a victim blocks a persistent unwanted caller.
      if (unwanted) {
        const uk = `${callee}|${a.user_id}`;
        const cnt = (state.unwanted.get(uk) ?? 0) + 1;
        state.unwanted.set(uk, cnt);
        const threshold = 2 + Math.floor(b.blockPropensity * 4);
        if (cnt >= threshold && !state.blocked.has(uk) && rng.bool(b.blockPropensity)) {
          state.blocked.add(uk);
          res.blocks.push({ owner: callee, contact: a.user_id, ts: tsAt(Math.min(0.99, frac + 0.01)), reason: 'spam' });
          res.behavior.push({ user_id: callee, event_type: 'block', target_user_id: a.user_id, ts: created });
        }
      }
    }
  }

  state.totalCalls += res.calls.length;
  return res;
}

function chooseCallee(rng: Rng, a: SimAccount, mode: string, unknownRate: number, graph: SimGraph): string | null {
  const contacts = graph.contacts.get(a.user_id) ?? [];
  if (mode === 'harass') {
    return a.victimIds.length ? rng.pick(a.victimIds) : null;
  }
  if (mode === 'spam') {
    if (a.persona === 'scammer' && a.ringId !== null) {
      const pool = graph.ringTargets.get(a.ringId) ?? graph.targetPool;
      return pool.length ? rng.pick(pool) : null;
    }
    return graph.targetPool.length ? rng.pick(graph.targetPool) : null;
  }
  // normal: mostly contacts, sometimes a cold unknown
  if (contacts.length && !rng.bool(unknownRate)) return rng.pick(contacts).id;
  return graph.targetPool.length ? rng.pick(graph.targetPool) : (contacts.length ? rng.pick(contacts).id : null);
}

function ensureChannel(state: SimState, calleeId: string): string {
  let ch = state.channelOf.get(calleeId);
  if (!ch) { ch = randomUUID(); state.channelOf.set(calleeId, ch); state.newChannels.push({ channel_id: ch, owner_id: calleeId }); }
  return ch;
}

// ─── Persistence ────────────────────────────────────────────────────────────

export async function persistWindow(res: WindowResult, state: SimState): Promise<void> {
  // New reachability channels referenced this window.
  if (state.newChannels.length) {
    const pending = state.newChannels.splice(0, state.newChannels.length);
    for (const batch of chunk(pending, 200)) {
      const cols: string[] = []; const args: unknown[] = [];
      batch.forEach((r, j) => { const b = j * 2; cols.push(`($${b+1},$${b+2},'sim')`); args.push(r.channel_id, r.owner_id); });
      await query(`INSERT INTO reachability_channels (channel_id, owner_id, label) VALUES ${cols.join(',')} ON CONFLICT (channel_id) DO NOTHING`, args);
    }
  }
  // Calls
  for (const batch of chunk(res.calls, 200)) {
    const cols: string[] = []; const args: unknown[] = [];
    batch.forEach((r, j) => {
      const b = j * 8;
      cols.push(`($${b+1},$${b+2},$${b+3}::call_type,$${b+4}::call_status,$${b+5},$${b+6}::timestamptz,$${b+7}::timestamptz,$${b+8})`);
      args.push(r.caller_id, r.callee_id, r.call_type, r.status, r.duration_seconds, r.created_at, r.ended_at, r.channel_id);
    });
    await query(`INSERT INTO calls (caller_id, callee_id, call_type, status, duration_seconds, created_at, ended_at, channel_id) VALUES ${cols.join(',')}`, args);
  }
  // Channel usage
  for (const batch of chunk(res.usage, 300)) {
    const cols: string[] = []; const args: unknown[] = [];
    batch.forEach((r, j) => { const b = j * 4; cols.push(`($${b+1},$${b+2},$${b+3},$${b+4}::timestamptz)`); args.push(r.channel_id, r.caller_id, r.action, r.ts); });
    await query(`INSERT INTO channel_usage_log (channel_id, caller_id, action, created_at) VALUES ${cols.join(',')}`, args);
  }
  // Behavior events
  for (const batch of chunk(res.behavior, 300)) {
    const cols: string[] = []; const args: unknown[] = [];
    batch.forEach((r, j) => { const b = j * 4; cols.push(`($${b+1},$${b+2},$${b+3},$${b+4}::timestamptz)`); args.push(r.user_id, r.event_type, r.target_user_id, r.ts); });
    await query(`INSERT INTO behavior_events (user_id, event_type, target_user_id, created_at) VALUES ${cols.join(',')}`, args);
  }
  // Blocks: delete existing then insert fresh (preserve backdated updated_at past the BEFORE UPDATE trigger).
  if (res.blocks.length) {
    for (const batch of chunk(res.blocks, 200)) {
      const delCols: string[] = []; const delArgs: unknown[] = [];
      batch.forEach((r, j) => { const b = j * 2; delCols.push(`($${b+1},$${b+2})`); delArgs.push(r.owner, r.contact); });
      await query(`DELETE FROM connections WHERE (owner_id, contact_id) IN (${delCols.join(',')})`, delArgs);
      const insCols: string[] = []; const insArgs: unknown[] = [];
      batch.forEach((r, j) => { const b = j * 3; insCols.push(`($${b+1},$${b+2},'blocked',$${b+3}::timestamptz,$${b+3}::timestamptz)`); insArgs.push(r.owner, r.contact, r.ts); });
      await query(`INSERT INTO connections (owner_id, contact_id, connection_type, created_at, updated_at) VALUES ${insCols.join(',')}`, insArgs);
    }
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
