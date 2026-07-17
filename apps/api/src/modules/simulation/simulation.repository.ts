/**
 * Simulation repository — all DB work for the dev-only trust/shadow simulator. Seeds a
 * reproducible synthetic population (identity-free `tsim_` users so KYC dedup never
 * applies), wires a connection graph, emits calls / blocks / dialer observations that
 * mimic genuine vs. spammer behaviour, recomputes trust inline, and tears it all down.
 *
 * Persona is encoded in the handle suffix (`…_g` genuine, `…_s` spammer) so the whole
 * population is self-describing. Everything is namespaced to `tsim_`; teardown deletes
 * exactly that set (cascades clear dependents) plus any now-orphaned shadow rows. Never
 * touches real user data.
 */
import crypto from 'node:crypto';
import {
  db,
  users,
  trustFactors,
  connections,
  calls,
  behaviorEvents,
  dialerObservations,
  trustScoreHistory,
  eq,
  sql,
} from '@trustroute/core';
import { makeRng } from './simulation.rng';

const PREFIX = 'tsim_';
const GENUINE_FACTORS = ['phone_verified', 'device_integrity', 'liveness_check', 'govt_id_verified'] as const;
const WEIGHTS = { phone_verified: 15, device_integrity: 10, liveness_check: 25, govt_id_verified: 30, profile_complete: 5, account_age: 5 };

type Persona = 'genuine' | 'spammer';
export interface SimUser { userId: string; handle: string; persona: Persona }

function tier(score: number): 'anonymous' | 'basic' | 'verified' | 'premium' {
  if (score >= 80) return 'premium';
  if (score >= 50) return 'verified';
  if (score >= 30) return 'basic';
  return 'anonymous';
}
const personaOf = (handle: string): Persona => (handle.endsWith('_s') ? 'spammer' : 'genuine');

/** Seed `count` synthetic users with trust factors, a connection graph, and observations. */
export async function seed(count: number, seedNum: number, spammerRatio: number) {
  const rng = makeRng(seedNum);
  const rows: SimUser[] = [];
  for (let i = 0; i < count; i++) {
    const persona: Persona = rng.chance(spammerRatio) ? 'spammer' : 'genuine';
    rows.push({ userId: crypto.randomUUID(), handle: `${PREFIX}${seedNum}_${i}_${persona === 'spammer' ? 's' : 'g'}`, persona });
  }

  await db.insert(users).values(
    rows.map((u) => ({
      userId: u.userId,
      handle: u.handle,
      displayName: `Sim ${u.handle}`,
      avatarUrl: `https://mock-cdn.trustroute.dev/sim/${u.handle}.png`,
      shadowTrustEnabled: true,
    })),
  );

  // Trust factors: genuine users verify most; spammers barely any.
  const factorRows: Array<typeof trustFactors.$inferInsert> = [];
  for (const u of rows) {
    const set = u.persona === 'genuine' ? GENUINE_FACTORS.filter(() => rng.chance(0.85)) : GENUINE_FACTORS.slice(0, 1).filter(() => rng.chance(0.4));
    for (const f of set) factorRows.push({ userId: u.userId, factorType: f, status: 'completed', isLatest: true, scoreDelta: WEIGHTS[f] });
  }
  if (factorRows.length) await db.insert(trustFactors).values(factorRows);

  // Connection graph: each user links to a handful of others.
  const connSeen = new Set<string>();
  const connRows: Array<typeof connections.$inferInsert> = [];
  for (const u of rows) {
    for (let d = 0, degree = rng.int(2, 6); d < degree; d++) {
      const other = rng.pick(rows);
      if (other.userId === u.userId || connSeen.has(`${u.userId}:${other.userId}`)) continue;
      connSeen.add(`${u.userId}:${other.userId}`);
      const type = other.persona === 'spammer' && rng.chance(0.6) ? 'blocked' : rng.chance(0.5) ? 'trusted' : 'unknown';
      connRows.push({ ownerId: u.userId, contactId: other.userId, connectionType: type });
    }
  }
  if (connRows.length) await db.insert(connections).values(connRows).onConflictDoNothing();

  // Dialer observations against external numbers (shadow-trust fuel).
  const obsRows: Array<typeof dialerObservations.$inferInsert> = [];
  const goodOutcomes = ['picked_up', 'saved', 'incoming_accepted'] as const;
  const badOutcomes = ['blocked', 'declined', 'hung_up_fast', 'incoming_blocked'] as const;
  for (const u of rows.slice(0, Math.min(rows.length, 40))) {
    for (let n = 0, numbers = rng.int(3, 8); n < numbers; n++) {
      const phoneHash = crypto.createHash('sha256').update(`${PREFIX}num_${seedNum}_${rng.int(0, 60)}`).digest('hex');
      const good = rng.chance(0.7);
      obsRows.push({
        observerId: u.userId,
        phoneHash,
        outcome: rng.pick(good ? goodOutcomes : badOutcomes),
        weight: '1.000',
        observedAt: sql`now() - (${rng.int(0, 120)} || ' days')::interval` as unknown as Date,
      });
    }
  }
  if (obsRows.length) await db.insert(dialerObservations).values(obsRows).onConflictDoNothing();

  return {
    users: rows.length,
    genuine: rows.filter((r) => r.persona === 'genuine').length,
    spammers: rows.filter((r) => r.persona === 'spammer').length,
    observations: obsRows.length,
  };
}

/** Emit synthetic calls: spammers fan out to many callees with high decline (mass outreach). */
export async function generateCalls(seedNum: number): Promise<{ calls: number; blocks: number }> {
  const rng = makeRng(seedNum ^ 0x5eed);
  const simUsers = await listSimUsers();
  const genuine = simUsers.filter((u) => u.persona === 'genuine');
  const spammers = simUsers.filter((u) => u.persona === 'spammer');

  const callRows: Array<typeof calls.$inferInsert> = [];
  for (const u of simUsers) {
    const isSpammer = u.persona === 'spammer';
    for (let c = 0, n = isSpammer ? rng.int(18, 30) : rng.int(0, 4); c < n; c++) {
      const callee = rng.pick(simUsers);
      if (callee.userId === u.userId) continue;
      const declined = isSpammer ? rng.chance(0.75) : rng.chance(0.2);
      callRows.push({
        callerId: u.userId,
        calleeId: callee.userId,
        callType: 'direct',
        status: declined ? 'declined' : 'ended',
        durationSeconds: declined ? null : rng.int(20, 400),
        createdAt: sql`now() - (${rng.int(0, 55)} || ' minutes')::interval` as unknown as Date,
      });
    }
  }
  if (callRows.length) await db.insert(calls).values(callRows);

  // Genuine users block the spammers who reached them.
  const behaviorRows: Array<typeof behaviorEvents.$inferInsert> = [];
  let blocks = 0;
  for (const s of spammers) {
    for (const b of genuine.filter(() => rng.chance(0.5)).slice(0, 12)) {
      await db
        .insert(connections)
        .values({ ownerId: b.userId, contactId: s.userId, connectionType: 'blocked' })
        .onConflictDoUpdate({ target: [connections.ownerId, connections.contactId], set: { connectionType: 'blocked', updatedAt: sql`now()` } });
      behaviorRows.push({ userId: s.userId, eventType: 'blocked_by_contact', targetUserId: b.userId });
      blocks++;
    }
  }
  if (behaviorRows.length) await db.insert(behaviorEvents).values(behaviorRows);
  return { calls: callRows.length, blocks };
}

/** Recompute trust inline for every sim user (bypasses the worker's `tsim_` guard). */
export async function recomputeTrust(): Promise<{ recomputed: number }> {
  const simUsers = await listSimUsers();
  for (const u of simUsers) {
    const factors = await db
      .select({ factorType: trustFactors.factorType })
      .from(trustFactors)
      .where(sql`${trustFactors.userId} = ${u.userId} AND ${trustFactors.status} = 'completed' AND ${trustFactors.isLatest} = TRUE`);
    let score = WEIGHTS.profile_complete; // sim users always have display name + avatar
    for (const f of factors) score += WEIGHTS[f.factorType as keyof typeof WEIGHTS] ?? 0;
    score = Math.max(0, Math.min(100, score));
    const t = tier(score);
    const [cur] = await db.select({ trustScore: users.trustScore, trustTier: users.trustTier }).from(users).where(eq(users.userId, u.userId)).limit(1);
    if (cur && (cur.trustScore !== score || cur.trustTier !== t)) {
      await db.update(users).set({ trustScore: score, trustTier: t, updatedAt: sql`now()` }).where(eq(users.userId, u.userId));
      await db.insert(trustScoreHistory).values({ userId: u.userId, oldScore: cur.trustScore, newScore: score, oldTier: cur.trustTier, newTier: t, reason: 'simulation' });
    }
  }
  return { recomputed: simUsers.length };
}

export async function listSimUsers(): Promise<SimUser[]> {
  const rows = await db.select({ userId: users.userId, handle: users.handle }).from(users).where(sql`${users.handle} LIKE ${PREFIX + '%'}`);
  return rows.map((r) => ({ userId: r.userId, handle: r.handle, persona: personaOf(r.handle) }));
}

export async function metrics() {
  const dist = await db.execute(sql`SELECT trust_tier, COUNT(*)::int AS n FROM users WHERE handle LIKE ${PREFIX + '%'} GROUP BY trust_tier ORDER BY trust_tier`);
  const total = await db.execute(sql`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE is_under_review)::int AS review FROM users WHERE handle LIKE ${PREFIX + '%'}`);
  const shadow = await db.execute(sql`SELECT COUNT(*)::int AS n, COALESCE(ROUND(AVG(shadow_score)),0)::int AS avg FROM shadow_numbers`);
  const simCalls = await db.execute(sql`SELECT COUNT(*)::int AS n FROM calls c JOIN users u ON u.user_id = c.caller_id WHERE u.handle LIKE ${PREFIX + '%'}`);
  const t = total.rows[0] as { n: number; review: number };
  const s = shadow.rows[0] as { n: number; avg: number };
  return {
    users: Number(t?.n ?? 0),
    underReview: Number(t?.review ?? 0),
    tierDistribution: dist.rows,
    shadowNumbers: Number(s?.n ?? 0),
    shadowAvgScore: Number(s?.avg ?? 0),
    simCalls: Number((simCalls.rows[0] as { n: number } | undefined)?.n ?? 0),
  };
}

/** Delete every simulation artefact (cascades clear dependents) + orphaned shadow rows. */
export async function teardown(): Promise<{ removedUsers: number; removedShadow: number }> {
  const removed = await db.delete(users).where(sql`${users.handle} LIKE ${PREFIX + '%'}`).returning({ id: users.userId });
  // Sim observations are gone via cascade; drop shadow rows that now have no backing observations.
  const shadow = await db.execute(sql`
    DELETE FROM shadow_numbers sn
    WHERE NOT EXISTS (SELECT 1 FROM dialer_observations o WHERE o.phone_hash = sn.phone_hash)
    RETURNING phone_hash
  `);
  return { removedUsers: removed.length, removedShadow: shadow.rows.length };
}
