/**
 * Simulation Router — PrivID Algorithm Testing
 *
 * Protected by SIMULATION_KEY env var. For testing/investor demo only.
 * Allows seeding a 3-day scenario with 8 personas directly into the DB
 * so the real algorithm can be measured against real history.
 *
 * Endpoints:
 *   POST  /simulation/setup      — seed all personas + 3-day call history
 *   GET   /simulation/state      — current state of all sim users
 *   POST  /simulation/test-call  — dry-run call permission check (no DB write)
 *   DELETE /simulation/teardown  — remove all simulation data
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { query, queryOne } from '@privid/shared';
import { AppError } from '../middleware/errorHandler';
import crypto from 'crypto';

export const simulationRouter = Router();

const SIM_KEY = process.env.SIMULATION_KEY ?? 'privid-sim-2024';

function requireSimKey(req: Request, _res: Response, next: NextFunction) {
  const key = req.body?.sim_key ?? req.query?.sim_key;
  if (key !== SIM_KEY) return next(new AppError(401, 'UNAUTHORIZED', 'Invalid simulation key.'));
  next();
}

// ─── Persona definitions ──────────────────────────────────────────────────────

const SIM_USERS = [
  {
    user_id: '10000000-0000-0000-0000-000000000001',
    handle: 'sim_alice',
    display_name: 'Alice Chen',
    phone_e164: '+10000000001',
    trust_tier: 'verified',
    trust_score: 50,
    discovery_mode: 'public',
    factors: ['phone_verified', 'device_integrity', 'liveness_check'],
  },
  {
    user_id: '10000000-0000-0000-0000-000000000002',
    handle: 'sim_bob',
    display_name: 'Bob Kumar',
    phone_e164: '+10000000002',
    trust_tier: 'basic',
    trust_score: 30,
    discovery_mode: 'private',
    factors: ['phone_verified', 'device_integrity'],
  },
  {
    user_id: '10000000-0000-0000-0000-000000000003',
    handle: 'sim_carol',
    display_name: 'Carol Patel',
    phone_e164: '+10000000003',
    trust_tier: 'premium',
    trust_score: 80,
    discovery_mode: 'public',
    factors: ['phone_verified', 'device_integrity', 'liveness_check', 'govt_id_verified'],
  },
  {
    user_id: '10000000-0000-0000-0000-000000000004',
    handle: 'sim_dave',
    display_name: 'Dave Singh',
    phone_e164: '+10000000004',
    trust_tier: 'anonymous',
    trust_score: 15,
    discovery_mode: 'public',
    factors: ['phone_verified'],
  },
  {
    user_id: '10000000-0000-0000-0000-000000000005',
    handle: 'sim_eve',
    display_name: 'Eve Sharma',
    phone_e164: '+10000000005',
    trust_tier: 'basic',
    trust_score: 30,
    discovery_mode: 'private',
    factors: ['phone_verified', 'device_integrity'],
  },
  {
    user_id: '10000000-0000-0000-0000-000000000006',
    handle: 'sim_frank',
    display_name: 'Frank (Spammer)',
    phone_e164: '+10000000006',
    trust_tier: 'anonymous',
    trust_score: 0,        // started at 15, penalties brought to 0
    discovery_mode: 'public',
    factors: ['phone_verified'],
  },
  {
    user_id: '10000000-0000-0000-0000-000000000007',
    handle: 'sim_gary',
    display_name: 'Gary (Harasser)',
    phone_e164: '+10000000007',
    trust_tier: 'anonymous',
    trust_score: 12,       // started at 15, -3 from Alice's block
    discovery_mode: 'public',
    factors: ['phone_verified'],
  },
  {
    user_id: '10000000-0000-0000-0000-000000000008',
    handle: 'sim_ivan',
    display_name: 'Ivan Petrov',
    phone_e164: '+10000000008',
    trust_tier: 'basic',
    trust_score: 32,       // phone+device+profile+age=35, -3 Alice block=32
    discovery_mode: 'public',
    factors: ['phone_verified', 'device_integrity'],
  },
] as const;

type SimHandle =
  | 'sim_alice' | 'sim_bob' | 'sim_carol' | 'sim_dave'
  | 'sim_eve' | 'sim_frank' | 'sim_gary' | 'sim_ivan';

const USER_MAP = Object.fromEntries(SIM_USERS.map(u => [u.handle, u])) as Record<SimHandle, typeof SIM_USERS[number]>;

function uid(handle: SimHandle): string { return USER_MAP[handle].user_id; }

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function ago(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

// ─── 3-day call history ───────────────────────────────────────────────────────
// Timestamps chosen so cooldowns are CURRENTLY ACTIVE for Frank/Gary on the key pairs.
//
// Dynamic cooldown rules:
//   last=answered/ended → 0ms  |  1 missed → 5m  |  2 missed → 20m  |  3+ → 2hr
//
// Active cooldowns at "now":
//   Frank→Dave:  last at T-1h   → 1hr remaining
//   Frank→Alice: last at T-0.5h → 1.5hr remaining
//   Frank→Carol: last at T-0.75h→ 1.25hr remaining
//   Gary→Alice:  last at T-1.75h→ 15min remaining  (then Alice blocked him)

interface SimCall {
  caller: SimHandle;
  callee: SimHandle;
  status: 'missed' | 'declined' | 'ended';
  hoursAgo: number;
}

const CALL_HISTORY: SimCall[] = [
  // ── Carol (power user, all calls answered) ────────────────────────────────
  { caller: 'sim_carol', callee: 'sim_bob',   status: 'ended',  hoursAgo: 71   },
  { caller: 'sim_carol', callee: 'sim_dave',  status: 'ended',  hoursAgo: 70   },
  { caller: 'sim_carol', callee: 'sim_alice', status: 'ended',  hoursAgo: 68   },
  { caller: 'sim_carol', callee: 'sim_ivan',  status: 'ended',  hoursAgo: 45   },
  { caller: 'sim_carol', callee: 'sim_alice', status: 'ended',  hoursAgo: 44   },
  { caller: 'sim_carol', callee: 'sim_bob',   status: 'ended',  hoursAgo: 22   },
  { caller: 'sim_carol', callee: 'sim_dave',  status: 'ended',  hoursAgo: 21   },
  { caller: 'sim_carol', callee: 'sim_alice', status: 'ended',  hoursAgo: 4    },

  // ── Ivan (normal user, blocked by Alice only) ────────────────────────────
  { caller: 'sim_ivan',  callee: 'sim_dave',  status: 'ended',  hoursAgo: 69   },
  { caller: 'sim_ivan',  callee: 'sim_carol', status: 'ended',  hoursAgo: 46   },
  { caller: 'sim_ivan',  callee: 'sim_dave',  status: 'ended',  hoursAgo: 23   },

  // ── Frank→Dave escalation: 0→5m→20m→2hr→2hr(active) ─────────────────────
  { caller: 'sim_frank', callee: 'sim_dave',  status: 'missed', hoursAgo: 72   },  // #1 no cooldown
  { caller: 'sim_frank', callee: 'sim_dave',  status: 'missed', hoursAgo: 71.9 },  // #2 5m elapsed → 20m
  { caller: 'sim_frank', callee: 'sim_dave',  status: 'missed', hoursAgo: 71.5 },  // #3 20m elapsed → 2hr
  { caller: 'sim_frank', callee: 'sim_dave',  status: 'missed', hoursAgo: 68.4 },  // #4 2hr elapsed → 2hr
  { caller: 'sim_frank', callee: 'sim_dave',  status: 'missed', hoursAgo: 1    },  // #5 2hr elapsed → 2hr ACTIVE

  // ── Frank→Alice escalation ────────────────────────────────────────────────
  { caller: 'sim_frank', callee: 'sim_alice', status: 'missed', hoursAgo: 71   },
  { caller: 'sim_frank', callee: 'sim_alice', status: 'missed', hoursAgo: 70.9 },
  { caller: 'sim_frank', callee: 'sim_alice', status: 'missed', hoursAgo: 70.5 },
  { caller: 'sim_frank', callee: 'sim_alice', status: 'missed', hoursAgo: 67.4 },
  { caller: 'sim_frank', callee: 'sim_alice', status: 'missed', hoursAgo: 0.5  },  // 30m ago → 2hr ACTIVE

  // ── Frank→Carol escalation ────────────────────────────────────────────────
  { caller: 'sim_frank', callee: 'sim_carol', status: 'missed', hoursAgo: 70   },
  { caller: 'sim_frank', callee: 'sim_carol', status: 'missed', hoursAgo: 69.9 },
  { caller: 'sim_frank', callee: 'sim_carol', status: 'missed', hoursAgo: 69.5 },
  { caller: 'sim_frank', callee: 'sim_carol', status: 'missed', hoursAgo: 66.4 },
  { caller: 'sim_frank', callee: 'sim_carol', status: 'missed', hoursAgo: 0.75 },  // 45m ago → 2hr ACTIVE

  // ── Gary→Alice targeted harassment ───────────────────────────────────────
  { caller: 'sim_gary',  callee: 'sim_alice', status: 'missed', hoursAgo: 68   },  // #1
  { caller: 'sim_gary',  callee: 'sim_alice', status: 'missed', hoursAgo: 67.9 },  // #2 5m → 20m
  { caller: 'sim_gary',  callee: 'sim_alice', status: 'missed', hoursAgo: 67.5 },  // #3 20m → 2hr
  { caller: 'sim_gary',  callee: 'sim_alice', status: 'missed', hoursAgo: 1.75 },  // #4 2hr → 2hr; Alice then blocked Gary

  // Gary also tried Dave (but cooldown expired → shows gap, Gary can reach Dave again)
  { caller: 'sim_gary',  callee: 'sim_dave',  status: 'missed', hoursAgo: 67   },
  { caller: 'sim_gary',  callee: 'sim_dave',  status: 'missed', hoursAgo: 66.9 },
];

// ─── Helper: replicate call permission logic (read-only) ─────────────────────

function cooldownMs(calls: Array<{ status: string }>): number {
  if (calls.length === 0) return 0;
  if (calls[0].status === 'answered' || calls[0].status === 'ended') return 0;
  let n = 0;
  for (const c of calls) {
    if (c.status === 'answered' || c.status === 'ended') break;
    n++;
  }
  if (n === 1) return 5 * 60 * 1000;
  if (n === 2) return 20 * 60 * 1000;
  return 2 * 60 * 60 * 1000;
}

async function checkPermission(callerId: string, calleeId: string): Promise<{
  allowed: boolean;
  error_code: string | null;
  message: string;
  cooldown_remaining_s: number | null;
  connection_type: string;
  consecutive_unanswered: number;
}> {
  const [calleeConn, calleeUser] = await Promise.all([
    queryOne<{ connection_type: string; temporary_expires_at: string | null }>(
      `SELECT connection_type, temporary_expires_at FROM connections WHERE owner_id = $1 AND contact_id = $2`,
      [calleeId, callerId],
    ),
    queryOne<{ discovery_mode: string }>(
      `SELECT discovery_mode FROM users WHERE user_id = $1`,
      [calleeId],
    ),
  ]);

  const connType = calleeConn?.connection_type ?? 'unknown';

  if (calleeUser?.discovery_mode === 'private' && connType === 'unknown') {
    return { allowed: false, error_code: 'DISCOVERY_PRIVATE', message: 'Private mode — only existing contacts can call.', cooldown_remaining_s: null, connection_type: connType, consecutive_unanswered: 0 };
  }

  if (connType === 'blocked') {
    return { allowed: false, error_code: 'CALLER_BLOCKED', message: 'Caller is blocked by this user.', cooldown_remaining_s: null, connection_type: connType, consecutive_unanswered: 0 };
  }

  if (connType === 'temporary' && calleeConn?.temporary_expires_at) {
    if (new Date() > new Date(calleeConn.temporary_expires_at)) {
      return { allowed: false, error_code: 'TEMPORARY_EXPIRED', message: 'Temporary access expired.', cooldown_remaining_s: null, connection_type: connType, consecutive_unanswered: 0 };
    }
  }

  if (connType === 'unknown' || connType === 'temporary') {
    const dailyLimit = connType === 'temporary' ? 5 : 4;
    const [countRow] = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM calls WHERE caller_id = $1 AND callee_id = $2 AND created_at >= CURRENT_DATE`,
      [callerId, calleeId],
    );
    if (parseInt(countRow.count) >= dailyLimit) {
      return { allowed: false, error_code: 'DAILY_LIMIT_REACHED', message: 'Daily call limit reached for this contact.', cooldown_remaining_s: null, connection_type: connType, consecutive_unanswered: 0 };
    }

    if (connType === 'unknown') {
      const recentCalls = await query<{ status: string; created_at: string }>(
        `SELECT status, created_at FROM calls WHERE caller_id = $1 AND callee_id = $2 ORDER BY created_at DESC LIMIT 5`,
        [callerId, calleeId],
      );
      const cdMs = cooldownMs(recentCalls);
      let consecutive = 0;
      for (const c of recentCalls) {
        if (c.status === 'answered' || c.status === 'ended') break;
        consecutive++;
      }
      if (recentCalls.length > 0 && cdMs > 0) {
        const elapsed = Date.now() - new Date(recentCalls[0].created_at).getTime();
        if (elapsed < cdMs) {
          const remainSec = Math.ceil((cdMs - elapsed) / 1000);
          return { allowed: false, error_code: 'COOLDOWN_ACTIVE', message: `Cooldown active: ${Math.ceil(remainSec / 60)} min remaining.`, cooldown_remaining_s: remainSec, connection_type: connType, consecutive_unanswered: consecutive };
        }
      }
      return { allowed: true, error_code: null, message: 'Permitted (unknown, no cooldown).', cooldown_remaining_s: null, connection_type: connType, consecutive_unanswered: consecutive };
    }
  }

  return { allowed: true, error_code: null, message: 'Permitted.', cooldown_remaining_s: null, connection_type: connType, consecutive_unanswered: 0 };
}

// ─── POST /simulation/setup ───────────────────────────────────────────────────

simulationRouter.post('/setup', requireSimKey, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // 1. Clean up existing simulation data
    const simIds = SIM_USERS.map(u => u.user_id);
    await query(`DELETE FROM behavior_events WHERE user_id = ANY($1::uuid[])`, [simIds]);
    await query(`DELETE FROM trust_score_history WHERE user_id = ANY($1::uuid[])`, [simIds]);
    await query(`DELETE FROM trust_factors WHERE user_id = ANY($1::uuid[])`, [simIds]);
    await query(`DELETE FROM connections WHERE owner_id = ANY($1::uuid[]) OR contact_id = ANY($1::uuid[])`, [simIds]);
    await query(`DELETE FROM calls WHERE caller_id = ANY($1::uuid[]) OR callee_id = ANY($1::uuid[])`, [simIds]);
    await query(`DELETE FROM users WHERE user_id = ANY($1::uuid[])`, [simIds]);

    // 2. Create users
    for (const u of SIM_USERS) {
      await query(
        `INSERT INTO users (user_id, phone_e164, phone_hash, handle, display_name, trust_tier, trust_score, discovery_mode, is_active, created_at)
         VALUES ($1,$2,$3,$4,$5,$6::trust_tier,$7,$8,true, NOW() - INTERVAL '30 days')`,
        [u.user_id, u.phone_e164, sha256(u.phone_e164), u.handle, u.display_name, u.trust_tier, u.trust_score, u.discovery_mode],
      );
    }

    // 3. Insert trust factors
    const FACTOR_WEIGHTS: Record<string, number> = {
      phone_verified: 15, device_integrity: 10, liveness_check: 25, govt_id_verified: 30,
    };
    for (const u of SIM_USERS) {
      for (const f of u.factors) {
        await query(
          `INSERT INTO trust_factors (user_id, factor_type, status, score_delta, verified_at)
           VALUES ($1,$2,'completed',$3,NOW() - INTERVAL '25 days')`,
          [u.user_id, f, FACTOR_WEIGHTS[f] ?? 0],
        );
      }
    }

    // 4. Insert connections
    const connections = [
      // Carol trusts Bob and Dave (mutual)
      { owner: 'sim_carol', contact: 'sim_bob',   type: 'trusted' },
      { owner: 'sim_bob',   contact: 'sim_carol', type: 'trusted' },
      { owner: 'sim_carol', contact: 'sim_dave',  type: 'trusted' },
      { owner: 'sim_dave',  contact: 'sim_carol', type: 'trusted' },
      // Alice blocks Ivan (personal reason)
      { owner: 'sim_alice', contact: 'sim_ivan',  type: 'blocked' },
      // Alice blocks Frank (after Day 2)
      { owner: 'sim_alice', contact: 'sim_frank', type: 'blocked' },
      // Carol blocks Frank (after Day 2)
      { owner: 'sim_carol', contact: 'sim_frank', type: 'blocked' },
      // Dave is passive — he misses Frank's calls but doesn't bother blocking
      // (This lets the cooldown demo remain visible for Frank → Dave)
      // Alice blocks Gary (after 4th harassment call)
      { owner: 'sim_alice', contact: 'sim_gary',  type: 'blocked' },
    ] as const;

    for (const c of connections) {
      await query(
        `INSERT INTO connections (owner_id, contact_id, connection_type, updated_at)
         VALUES ($1,$2,$3::connection_type, NOW() - INTERVAL '24 hours')`,
        [uid(c.owner), uid(c.contact), c.type],
      );
    }

    // 5. Insert 3-day call history
    for (const c of CALL_HISTORY) {
      const roomId = crypto.randomBytes(8).toString('hex');
      await query(
        `INSERT INTO calls (caller_id, callee_id, call_type, webrtc_room_id, status, created_at, ended_at)
         VALUES ($1,$2,'direct',$3,$4::call_status,$5,$5)`,
        [uid(c.caller), uid(c.callee), roomId, c.status, ago(c.hoursAgo)],
      );
    }

    // 6. Behavior events for Frank (mass outreach flags)
    await query(
      `INSERT INTO behavior_events (user_id, event_type, created_at)
       VALUES ($1,'mass_outreach_flag',$2), ($1,'mass_outreach_flag',$3)`,
      [uid('sim_frank'), ago(66), ago(24)],
    );

    // 7. Trust score history for Frank (showing the decline)
    const frankTierHistory = [
      { hrs: 72, old: 15, new_: 15, oldT: 'anonymous', newT: 'anonymous', reason: 'Account created' },
      { hrs: 66, old: 15, new_: 10, oldT: 'anonymous', newT: 'anonymous', reason: 'Mass outreach flag #1 (-5)' },
      { hrs: 48, old: 10, new_: 7,  oldT: 'anonymous', newT: 'anonymous', reason: 'Blocked by Alice (-3)' },
      { hrs: 47.5, old: 7, new_: 4, oldT: 'anonymous', newT: 'anonymous', reason: 'Blocked by Carol (-3)' },
      { hrs: 47,  old: 4,  new_: 1, oldT: 'anonymous', newT: 'anonymous', reason: 'Blocked by Dave (-3)' },
      { hrs: 24,  old: 1,  new_: 0, oldT: 'anonymous', newT: 'anonymous', reason: 'Mass outreach flag #2 (-5) → floor 0' },
    ];
    for (const h of frankTierHistory) {
      await query(
        `INSERT INTO trust_score_history (user_id, old_score, new_score, old_tier, new_tier, reason, created_at)
         VALUES ($1,$2,$3,$4::trust_tier,$5::trust_tier,$6,$7)`,
        [uid('sim_frank'), h.old, h.new_, h.oldT, h.newT, h.reason, ago(h.hrs)],
      );
    }

    // Trust score history for Gary
    await query(
      `INSERT INTO trust_score_history (user_id, old_score, new_score, old_tier, new_tier, reason, created_at)
       VALUES ($1,15,12,'anonymous','anonymous','Blocked by Alice after harassment (-3)',$2)`,
      [uid('sim_gary'), ago(1.74)],
    );

    res.json({ ok: true, message: 'Simulation scenario seeded.', users: SIM_USERS.map(u => ({ handle: u.handle, display_name: u.display_name })) });
  } catch (err) {
    next(err);
  }
});

// ─── GET /simulation/state ────────────────────────────────────────────────────

simulationRouter.get('/state', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const key = req.query?.sim_key;
    if (key !== SIM_KEY) return next(new AppError(401, 'UNAUTHORIZED', 'Invalid simulation key.'));

    const simIds = SIM_USERS.map(u => u.user_id);

    // Fetch users
    const users = await query<{
      user_id: string; handle: string; display_name: string;
      trust_tier: string; trust_score: number; discovery_mode: string;
    }>(`SELECT user_id, handle, display_name, trust_tier, trust_score, discovery_mode FROM users WHERE user_id = ANY($1::uuid[])`, [simIds]);

    // Fetch call stats per user (as caller)
    const callStats = await query<{
      caller_id: string; total: string; answered: string; missed: string; declined: string;
    }>(`SELECT caller_id,
          COUNT(*)::text AS total,
          COUNT(*) FILTER (WHERE status IN ('answered','ended'))::text AS answered,
          COUNT(*) FILTER (WHERE status = 'missed')::text AS missed,
          COUNT(*) FILTER (WHERE status = 'declined')::text AS declined
        FROM calls WHERE caller_id = ANY($1::uuid[])
        GROUP BY caller_id`, [simIds]);

    const statsMap = Object.fromEntries(callStats.map(s => [s.caller_id, s]));

    // Fetch behavior flags per user
    const flags = await query<{ user_id: string; count: string }>(
      `SELECT user_id, COUNT(*)::text AS count FROM behavior_events
       WHERE user_id = ANY($1::uuid[]) AND event_type = 'mass_outreach_flag'
       GROUP BY user_id`, [simIds],
    );
    const flagsMap = Object.fromEntries(flags.map(f => [f.user_id, parseInt(f.count)]));

    // Fetch blocks received
    const blocks = await query<{ contact_id: string; count: string }>(
      `SELECT contact_id, COUNT(*)::text AS count FROM connections
       WHERE contact_id = ANY($1::uuid[]) AND connection_type = 'blocked'
       GROUP BY contact_id`, [simIds],
    );
    const blocksMap = Object.fromEntries(blocks.map(b => [b.contact_id, parseInt(b.count)]));

    // Compute current cooldowns for key pairs (Frank & Gary as callers)
    const problemCallers: SimHandle[] = ['sim_frank', 'sim_gary'];
    const cooldownPairs: Array<{
      caller_handle: string; callee_handle: string;
      cooldown_remaining_s: number | null; error_code: string | null;
    }> = [];

    for (const callerHandle of problemCallers) {
      const callerUser = USER_MAP[callerHandle];
      for (const u of SIM_USERS) {
        if (u.handle === callerHandle) continue;
        const result = await checkPermission(callerUser.user_id, u.user_id);
        if (!result.allowed || result.cooldown_remaining_s !== null) {
          cooldownPairs.push({
            caller_handle: callerHandle,
            callee_handle: u.handle,
            cooldown_remaining_s: result.cooldown_remaining_s,
            error_code: result.error_code,
          });
        }
      }
    }

    // Trust score history for Frank (for timeline chart)
    const trustHistory = await query<{
      old_score: number; new_score: number; reason: string; created_at: string; user_id: string;
    }>(
      `SELECT user_id, old_score, new_score, reason, created_at
       FROM trust_score_history WHERE user_id = ANY($1::uuid[])
       ORDER BY created_at ASC`, [simIds],
    );

    const result = users.map(u => ({
      ...u,
      call_stats: statsMap[u.user_id] ?? { total: '0', answered: '0', missed: '0', declined: '0' },
      mass_outreach_flags: flagsMap[u.user_id] ?? 0,
      blocks_received: blocksMap[u.user_id] ?? 0,
    }));

    res.json({ ok: true, data: { users: result, cooldown_pairs: cooldownPairs, trust_history: trustHistory } });
  } catch (err) {
    next(err);
  }
});

// ─── POST /simulation/test-call ───────────────────────────────────────────────

const testCallSchema = z.object({
  caller_handle: z.string(),
  callee_handle: z.string(),
  sim_key: z.string(),
});

simulationRouter.post('/test-call', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { caller_handle, callee_handle, sim_key } = testCallSchema.parse(req.body);
    if (sim_key !== SIM_KEY) return next(new AppError(401, 'UNAUTHORIZED', 'Invalid simulation key.'));

    const caller = SIM_USERS.find(u => u.handle === caller_handle);
    const callee = SIM_USERS.find(u => u.handle === callee_handle);
    if (!caller || !callee) return next(new AppError(404, 'NOT_FOUND', 'Unknown sim handle.'));
    if (caller.user_id === callee.user_id) return next(new AppError(400, 'SELF_CALL', 'Cannot call self.'));

    const result = await checkPermission(caller.user_id, callee.user_id);
    res.json({ ok: true, data: { caller_handle, callee_handle, ...result } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── DELETE /simulation/teardown ─────────────────────────────────────────────

simulationRouter.delete('/teardown', requireSimKey, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const simIds = SIM_USERS.map(u => u.user_id);
    await query(`DELETE FROM behavior_events WHERE user_id = ANY($1::uuid[])`, [simIds]);
    await query(`DELETE FROM trust_score_history WHERE user_id = ANY($1::uuid[])`, [simIds]);
    await query(`DELETE FROM trust_factors WHERE user_id = ANY($1::uuid[])`, [simIds]);
    await query(`DELETE FROM connections WHERE owner_id = ANY($1::uuid[]) OR contact_id = ANY($1::uuid[])`, [simIds]);
    await query(`DELETE FROM calls WHERE caller_id = ANY($1::uuid[]) OR callee_id = ANY($1::uuid[])`, [simIds]);
    await query(`DELETE FROM users WHERE user_id = ANY($1::uuid[])`, [simIds]);
    res.json({ ok: true, message: 'Simulation data removed.' });
  } catch (err) {
    next(err);
  }
});
