/**
 * Time-series simulation — social graph + DB seeding.
 *
 * Builds an in-memory relationship graph (who trusts whom, who harasses whom,
 * which targets a scammer ring shares) and seeds the accounts, verification
 * factors, and the initial connection graph into Postgres with timestamps
 * backdated to the virtual start (so history lands in the real last-N-days window).
 */

import { createHash } from 'crypto';
import { query } from '@trustroute/shared';
import { scoreToTier } from '@trustroute/shared';
import { Rng } from './rng';
import type { SimAccount, Persona } from './personas';

export interface SimGraph {
  /** contacts[ownerId] = list of {id, type} the owner has a relationship with */
  contacts: Map<string, { id: string; type: 'trusted' | 'temporary' | 'unknown' }[]>;
  /** normal/target accounts a spammer/scammer can cold-call */
  targetPool: string[];
  /** scammer ring -> shared target ids */
  ringTargets: Map<number, string[]>;
  byId: Map<string, SimAccount>;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const GOOD: Persona[] = ['normal_low', 'normal_high', 'power_user', 'private_safe', 'passive', 'personal_blocker'];

export function buildGraph(rng: Rng, accounts: SimAccount[]): SimGraph {
  const byId = new Map(accounts.map(a => [a.user_id, a]));
  const goodAccounts = accounts.filter(a => GOOD.includes(a.persona));
  const goodIds = goodAccounts.map(a => a.user_id);
  const targetPool = goodIds.slice();

  const contacts = new Map<string, { id: string; type: 'trusted' | 'temporary' | 'unknown' }[]>();
  for (const a of accounts) contacts.set(a.user_id, []);

  // Give each "good" account a handful of mutual trusted/temporary contacts.
  for (const a of goodAccounts) {
    const nContacts =
      a.persona === 'power_user' ? rng.int(12, 30) :
      a.persona === 'passive'    ? rng.int(1, 4) :
      rng.int(4, 12);
    const picks = rng.shuffle(goodIds.filter(id => id !== a.user_id)).slice(0, nContacts);
    for (const other of picks) {
      const type: 'trusted' | 'temporary' = rng.bool(0.6) ? 'trusted' : 'temporary';
      addContact(contacts, a.user_id, other, type);
      addContact(contacts, other, a.user_id, type); // mutual
    }
  }

  // Harassers get 1–2 fixed victims from the good pool.
  for (const a of accounts) {
    if (a.persona === 'harasser') {
      a.victimIds = rng.shuffle(goodIds).slice(0, rng.int(1, 2));
    }
  }

  // Scammer rings share a target pool (coordinated → shared_targets_with_flagged).
  const ringTargets = new Map<number, string[]>();
  for (const a of accounts) {
    if (a.persona === 'scammer' && a.ringId !== null && !ringTargets.has(a.ringId)) {
      ringTargets.set(a.ringId, rng.shuffle(goodIds).slice(0, rng.int(25, 60)));
    }
  }

  return { contacts, targetPool, ringTargets, byId };
}

function addContact(
  map: Map<string, { id: string; type: 'trusted' | 'temporary' | 'unknown' }[]>,
  owner: string, other: string, type: 'trusted' | 'temporary' | 'unknown',
): void {
  const list = map.get(owner)!;
  if (!list.some(c => c.id === other)) list.push({ id: other, type });
}

/**
 * Seed accounts, verification factors, and initial connections into Postgres.
 * All rows are backdated to `startTs` (virtual day 0).
 */
export async function seedDatabase(
  accounts: SimAccount[],
  graph: SimGraph,
  startTs: Date,
): Promise<void> {
  const startIso = startTs.toISOString();

  // ── Users ──────────────────────────────────────────────────────────────────
  for (const batch of chunk(accounts, 200)) {
    const cols: string[] = [];
    const args: unknown[] = [];
    batch.forEach((a, j) => {
      const b = j * 9;
      cols.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6}::trust_tier,$${b+7},$${b+8},$${b+9}::timestamptz,TRUE)`);
      args.push(a.user_id, a.phone_e164, sha256(a.phone_e164), a.handle, a.display_name,
                scoreToTier(a.base_score), a.base_score, a.discovery, startIso);
    });
    await query(
      `INSERT INTO users (user_id, phone_e164, phone_hash, handle, display_name, trust_tier, trust_score, discovery_mode, created_at, is_active)
       VALUES ${cols.join(',')}
       ON CONFLICT (user_id) DO NOTHING`,
      args,
    );
  }

  // ── Verification factors ─────────────────────────────────────────────────────
  const factorRows: { uid: string; type: string; delta: number }[] = [];
  const FW: Record<string, number> = { phone_verified: 15, device_integrity: 10, liveness_check: 25, govt_id_verified: 30 };
  for (const a of accounts) for (const f of a.factors) factorRows.push({ uid: a.user_id, type: f, delta: FW[f] ?? 0 });
  for (const batch of chunk(factorRows, 200)) {
    const cols: string[] = [];
    const args: unknown[] = [];
    batch.forEach((r, j) => {
      const b = j * 4;
      cols.push(`($${b+1},$${b+2},'completed',$${b+3},$${b+4}::timestamptz)`);
      args.push(r.uid, r.type, r.delta, startIso);
    });
    await query(
      `INSERT INTO trust_factors (user_id, factor_type, status, score_delta, verified_at) VALUES ${cols.join(',')}`,
      args,
    );
  }

  // ── Initial connections ──────────────────────────────────────────────────────
  const connRows: { owner: string; contact: string; type: string }[] = [];
  for (const [owner, list] of graph.contacts) {
    for (const c of list) connRows.push({ owner, contact: c.id, type: c.type });
  }
  for (const batch of chunk(connRows, 300)) {
    const cols: string[] = [];
    const args: unknown[] = [];
    batch.forEach((r, j) => {
      const b = j * 4;
      cols.push(`($${b+1},$${b+2},$${b+3}::connection_type,$${b+4}::timestamptz,$${b+4}::timestamptz)`);
      args.push(r.owner, r.contact, r.type, startIso);
    });
    await query(
      `INSERT INTO connections (owner_id, contact_id, connection_type, created_at, updated_at)
       VALUES ${cols.join(',')}
       ON CONFLICT DO NOTHING`,
      args,
    );
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
