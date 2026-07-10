/**
 * Time-series simulation — personas & account generation.
 *
 * Extends the static big-run persona set into a scaled, per-account-randomized
 * population for the time-series harness. Every account gets jittered behaviour
 * params so no two spammers (or normals) look identical, and some personas change
 * regime partway through the run (sleeper: normal→spam, reformed: spam→normal).
 *
 * All accounts are prefixed `tsim_` and use deterministic UUIDs so a run is
 * reproducible from its seed and trivially torn down.
 */

import { Rng } from './rng';

export type Persona =
  | 'normal_low' | 'normal_high' | 'power_user' | 'private_safe' | 'passive'
  | 'mass_spammer' | 'scammer' | 'harasser' | 'personal_blocker'
  | 'reformed' | 'sleeper';

/** Behaviour mode an account is in on a given virtual day. */
export type Mode = 'normal' | 'spam' | 'harass';

interface PersonaBase {
  weight: number;            // share of the population
  factors: string[];         // completed verification factors
  discovery: 'public' | 'private';
  callsPerDay: [number, number];
  unknownRate: number;       // fraction of outgoing calls to non-contacts
  answerIncoming: [number, number];
  blockPropensity: number;   // chance a victim of *this* account gets blocked isn't here;
                             // this is how readily THIS account blocks others it dislikes
  mode: Mode;                // steady-state behaviour
  isBad: boolean;            // ground-truth: should the system flag it?
  note?: string;
}

export const FACTOR_WEIGHTS: Record<string, number> = {
  phone_verified: 15, device_integrity: 10, liveness_check: 25, govt_id_verified: 30,
};

export const PERSONA_BASE: Record<Persona, PersonaBase> = {
  normal_low:       { weight: 0.22, factors: ['phone_verified'], discovery: 'public',  callsPerDay: [1, 6],   unknownRate: 0.25, answerIncoming: [0.6, 0.85], blockPropensity: 0.15, mode: 'normal', isBad: false },
  normal_high:      { weight: 0.15, factors: ['phone_verified','device_integrity','liveness_check'], discovery: 'public', callsPerDay: [3, 9], unknownRate: 0.18, answerIncoming: [0.75, 0.92], blockPropensity: 0.2, mode: 'normal', isBad: false },
  power_user:       { weight: 0.07, factors: ['phone_verified','device_integrity','liveness_check','govt_id_verified'], discovery: 'public', callsPerDay: [10, 22], unknownRate: 0.12, answerIncoming: [0.9, 0.98], blockPropensity: 0.1, mode: 'normal', isBad: false },
  private_safe:     { weight: 0.08, factors: ['phone_verified','device_integrity'], discovery: 'private', callsPerDay: [1, 4], unknownRate: 0.05, answerIncoming: [0.85, 0.97], blockPropensity: 0.3, mode: 'normal', isBad: false },
  passive:          { weight: 0.08, factors: ['phone_verified'], discovery: 'public', callsPerDay: [0, 2], unknownRate: 0.3, answerIncoming: [0.15, 0.4], blockPropensity: 0.1, mode: 'normal', isBad: false },
  mass_spammer:     { weight: 0.06, factors: ['phone_verified'], discovery: 'public', callsPerDay: [35, 55], unknownRate: 1.0, answerIncoming: [0, 0.05], blockPropensity: 0.0, mode: 'spam', isBad: true },
  scammer:          { weight: 0.07, factors: [], discovery: 'public', callsPerDay: [20, 40], unknownRate: 1.0, answerIncoming: [0, 0.03], blockPropensity: 0.0, mode: 'spam', isBad: true, note: 'ring member' },
  harasser:         { weight: 0.06, factors: ['phone_verified'], discovery: 'public', callsPerDay: [4, 9], unknownRate: 1.0, answerIncoming: [0, 0.05], blockPropensity: 0.0, mode: 'harass', isBad: true, note: 'low-volume; known detection gap' },
  personal_blocker: { weight: 0.09, factors: ['phone_verified','device_integrity'], discovery: 'public', callsPerDay: [2, 6], unknownRate: 0.15, answerIncoming: [0.65, 0.85], blockPropensity: 0.9, mode: 'normal', isBad: false, note: 'blocks contacts for personal reasons — false-positive risk' },
  reformed:         { weight: 0.05, factors: ['phone_verified'], discovery: 'public', callsPerDay: [30, 48], unknownRate: 1.0, answerIncoming: [0, 0.05], blockPropensity: 0.0, mode: 'spam', isBad: true, note: 'spam early, then normalises' },
  sleeper:          { weight: 0.07, factors: ['phone_verified','device_integrity'], discovery: 'public', callsPerDay: [3, 6], unknownRate: 0.2, answerIncoming: [0.7, 0.9], blockPropensity: 0.2, mode: 'normal', isBad: true, note: 'normal early, then flips to spam' },
};

export interface SimAccount {
  idx: number;
  user_id: string;
  handle: string;
  display_name: string;
  phone_e164: string;
  persona: Persona;
  factors: string[];
  base_score: number;        // verification points (deterministic)
  discovery: 'public' | 'private';
  isBad: boolean;
  // jittered behaviour params
  callsPerDay: number;
  unknownRate: number;
  answerIncoming: number;
  blockPropensity: number;
  activePeakHour: number;    // diurnal peak (0–23)
  ringId: number | null;     // scammer ring membership
  flipDay: number | null;    // regime change day (sleeper/reformed)
  victimIds: string[];       // fixed victims (harasser) — filled after graph build
}

const NAMES = ['Alex','Sam','Jordan','Taylor','Morgan','Casey','Riley','Drew','Quinn','Avery','Blake','Charlie','Dakota','Emery','Finley','Greer','Harper','Indigo','Jamie','Kendall','Lennon','Marlowe','Noel','Oakley','Parker','Remy','Sage','Tatum','Vale','Winter'];
const SURNAMES = ['Smith','Jones','Williams','Brown','Davis','Wilson','Taylor','Anderson','Thomas','Jackson','White','Harris','Martin','Thompson','Garcia','Martinez','Robinson','Clark','Rodriguez','Lewis'];

/** Deterministic, valid UUID from an index (reserved 3000… space for tsim). */
export function simUuid(idx: number): string {
  const h = idx.toString(16).padStart(12, '0');
  return `30000000-0000-4000-8000-${h}`;
}

/** Build the account population for a run. */
export function buildAccounts(rng: Rng, total: number, virtualDays: number): SimAccount[] {
  // Resolve per-persona counts from weights (largest-remainder to hit `total`).
  const entries = Object.entries(PERSONA_BASE) as [Persona, PersonaBase][];
  const raw = entries.map(([p, b]) => ({ p, b, exact: b.weight * total }));
  const counts = raw.map(r => ({ ...r, n: Math.floor(r.exact) }));
  let assigned = counts.reduce((s, r) => s + r.n, 0);
  counts.sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)));
  for (let k = 0; assigned < total; k++, assigned++) counts[k % counts.length].n++;

  const accounts: SimAccount[] = [];
  let idx = 0;
  let scammerRing = 0;
  for (const { p, b, n } of counts) {
    for (let i = 0; i < n; i++) {
      idx++;
      const factors = b.factors;
      const base = factors.reduce((s, f) => s + (FACTOR_WEIGHTS[f] ?? 0), 0);
      // scammers cluster into rings of ~8 that share a target pool
      const ringId = p === 'scammer' ? Math.floor(scammerRing++ / 8) : null;
      // regime flip day (sleeper flips later, reformed earlier)
      let flipDay: number | null = null;
      if (p === 'sleeper')  flipDay = Math.round(virtualDays * (0.4 + rng.next() * 0.25));
      if (p === 'reformed') flipDay = Math.round(virtualDays * (0.3 + rng.next() * 0.2));
      accounts.push({
        idx,
        user_id: simUuid(idx),
        handle: `tsim_${p}_${String(idx).padStart(4, '0')}`,
        display_name: `${rng.pick(NAMES)} ${rng.pick(SURNAMES)}`,
        phone_e164: `+1999${String(1_000_000 + idx).padStart(7, '0')}`,
        persona: p,
        factors,
        base_score: base,
        discovery: b.discovery,
        isBad: b.isBad,
        callsPerDay: rng.int(b.callsPerDay[0], b.callsPerDay[1]),
        unknownRate: clamp01(b.unknownRate + (rng.next() - 0.5) * 0.15),
        answerIncoming: rng.range(b.answerIncoming[0], b.answerIncoming[1]),
        blockPropensity: clamp01(b.blockPropensity + (rng.next() - 0.5) * 0.1),
        activePeakHour: rng.int(8, 21),
        ringId,
        flipDay,
        victimIds: [],
      });
    }
  }
  return accounts;
}

/** Behaviour of an account on a given virtual day (accounts for regime flips). */
export function behaviourAt(a: SimAccount, day: number): { mode: Mode; callsPerDay: number; unknownRate: number } {
  const base = PERSONA_BASE[a.persona];
  if (a.persona === 'sleeper' && a.flipDay !== null && day >= a.flipDay) {
    return { mode: 'spam', callsPerDay: Math.max(a.callsPerDay, 30) + Math.round(a.callsPerDay), unknownRate: 1.0 };
  }
  if (a.persona === 'reformed' && a.flipDay !== null && day >= a.flipDay) {
    return { mode: 'normal', callsPerDay: Math.max(2, Math.round(a.callsPerDay * 0.12)), unknownRate: 0.2 };
  }
  return { mode: base.mode, callsPerDay: a.callsPerDay, unknownRate: a.unknownRate };
}

/** Diurnal weight (0..1) for a virtual hour given an account's peak hour. */
export function diurnalWeight(hour: number, peak: number): number {
  const d = Math.min(Math.abs(hour - peak), 24 - Math.abs(hour - peak));
  return Math.max(0.05, 1 - d / 8); // bell-ish; near-zero deep at night
}

function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }
