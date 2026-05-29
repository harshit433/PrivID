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

// ═══════════════════════════════════════════════════════════════════════════════
// BIG SIMULATION — 200 users, 3-day chaos scenario
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Types ───────────────────────────────────────────────────────────────────

type PersonaType =
  | 'normal_low' | 'normal_high' | 'power_user' | 'private_safe'
  | 'passive' | 'mass_spammer' | 'harasser' | 'scammer'
  | 'personal_blocker' | 'reformed' | 'sleeper';

interface BigPersona {
  user_id: string;
  handle: string;
  display_name: string;
  phone_e164: string;
  persona_type: PersonaType;
  trust_tier: string;
  trust_score: number;
  discovery_mode: string;
  factors: string[];
}

interface DayScore {
  user_id: string;
  handle: string;
  persona_type: string;
  score: number;
  tier: string;
}

interface ValidationAssertion {
  user_id: string;
  handle: string;
  persona_type: string;
  assertion: string;
  expected: string;
  actual: string;
  passed: boolean;
}

// ─── Seeded PRNG (LCG) ───────────────────────────────────────────────────────

class Rng {
  private s: number;
  constructor(seed = 42) { this.s = seed >>> 0; }
  next(): number {
    this.s = ((Math.imul(1664525, this.s) + 1013904223) | 0) >>> 0;
    return this.s / 0xffffffff;
  }
  int(lo: number, hi: number): number { return Math.floor(this.next() * (hi - lo + 1)) + lo; }
  bool(p: number): boolean { return this.next() < p; }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)]; }
  shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}

// ─── Persona configs ──────────────────────────────────────────────────────────

interface PersonaConfig {
  count: number;
  factors: string[];
  base_score: number;
  discovery: 'public' | 'private';
  calls_per_day_range: [number, number];
  unknown_call_rate: number;
  answer_incoming_rate: number;
  // expected outcome after 3 days
  expected_score_range: [number, number];
  expected_under_review: boolean;
}

const PERSONA_CONFIGS: Record<PersonaType, PersonaConfig> = {
  normal_low: {
    count: 25,
    factors: ['phone_verified'],
    base_score: 15,
    discovery: 'public',
    calls_per_day_range: [2, 6],
    unknown_call_rate: 0.3,
    answer_incoming_rate: 0.7,
    expected_score_range: [8, 20],
    expected_under_review: false,
  },
  normal_high: {
    count: 20,
    factors: ['phone_verified', 'device_integrity', 'liveness_check'],
    base_score: 50,
    discovery: 'public',
    calls_per_day_range: [3, 8],
    unknown_call_rate: 0.2,
    answer_incoming_rate: 0.8,
    expected_score_range: [43, 60],
    expected_under_review: false,
  },
  power_user: {
    count: 15,
    factors: ['phone_verified', 'device_integrity', 'liveness_check', 'govt_id_verified'],
    base_score: 80,
    discovery: 'public',
    calls_per_day_range: [10, 20],
    unknown_call_rate: 0.1,
    answer_incoming_rate: 0.95,
    expected_score_range: [72, 85],
    expected_under_review: false,
  },
  private_safe: {
    count: 15,
    factors: ['phone_verified', 'device_integrity'],
    base_score: 30,
    discovery: 'private',
    calls_per_day_range: [1, 4],
    unknown_call_rate: 0.05,
    answer_incoming_rate: 0.9,
    expected_score_range: [25, 37],
    expected_under_review: false,
  },
  passive: {
    count: 15,
    factors: ['phone_verified'],
    base_score: 15,
    discovery: 'public',
    calls_per_day_range: [0, 2],
    unknown_call_rate: 0.4,
    answer_incoming_rate: 0.25,
    expected_score_range: [5, 20],
    expected_under_review: false,
  },
  mass_spammer: {
    count: 20,
    factors: ['phone_verified'],
    base_score: 15,
    discovery: 'public',
    calls_per_day_range: [35, 50],
    unknown_call_rate: 1.0,
    answer_incoming_rate: 0.0,
    expected_score_range: [0, 5],
    expected_under_review: true,
  },
  harasser: {
    count: 15,
    factors: ['phone_verified'],
    base_score: 15,
    discovery: 'public',
    calls_per_day_range: [4, 8],
    unknown_call_rate: 1.0,
    answer_incoming_rate: 0.0,
    expected_score_range: [0, 12],
    expected_under_review: true,
  },
  scammer: {
    count: 20,
    factors: [],
    base_score: 0,
    discovery: 'public',
    calls_per_day_range: [20, 35],
    unknown_call_rate: 1.0,
    answer_incoming_rate: 0.0,
    expected_score_range: [0, 3],
    expected_under_review: true,
  },
  personal_blocker: {
    count: 15,
    factors: ['phone_verified', 'device_integrity'],
    base_score: 30,
    discovery: 'public',
    calls_per_day_range: [2, 6],
    unknown_call_rate: 0.2,
    answer_incoming_rate: 0.75,
    expected_score_range: [20, 35],   // should NOT be under review
    expected_under_review: false,
  },
  reformed: {
    count: 15,
    factors: ['phone_verified'],
    base_score: 15,
    discovery: 'public',
    calls_per_day_range: [30, 45],    // day 1 (spam), then changes
    unknown_call_rate: 1.0,
    answer_incoming_rate: 0.0,
    expected_score_range: [0, 10],
    expected_under_review: true,       // caught from day 1 spam
  },
  sleeper: {
    count: 10,
    factors: ['phone_verified', 'device_integrity'],
    base_score: 30,
    discovery: 'public',
    calls_per_day_range: [3, 6],      // day 1 normal, day 2-3 spam
    unknown_call_rate: 0.2,
    answer_incoming_rate: 0.75,
    expected_score_range: [0, 12],
    expected_under_review: true,       // caught by day 3
  },
};

// ─── Helper: generate all 200 persona objects ─────────────────────────────────

function generatePersonas(rng: Rng): BigPersona[] {
  const personas: BigPersona[] = [];
  let idx = 0;
  const FACTOR_WEIGHTS: Record<string, number> = {
    phone_verified: 15, device_integrity: 10, liveness_check: 25, govt_id_verified: 30,
  };

  const NAMES = [
    'Alex','Sam','Jordan','Taylor','Morgan','Casey','Riley','Drew','Quinn','Avery',
    'Blake','Charlie','Dakota','Emery','Finley','Greer','Harper','Indigo','Jamie','Kendall',
    'Lennon','Marlowe','Noel','Oakley','Parker','Remy','Sage','Tatum','Vale','Winter',
  ];
  const SURNAMES = [
    'Smith','Jones','Williams','Brown','Davis','Wilson','Taylor','Anderson','Thomas','Jackson',
    'White','Harris','Martin','Thompson','Garcia','Martinez','Robinson','Clark','Rodriguez','Lewis',
  ];

  for (const [type, cfg] of Object.entries(PERSONA_CONFIGS) as [PersonaType, PersonaConfig][]) {
    for (let i = 0; i < cfg.count; i++) {
      idx++;
      const name = `${rng.pick(NAMES)} ${rng.pick(SURNAMES)}`;
      const userId = `20000000-0000-0000-${String(idx).padStart(4, '0')}-000000000001`;
      const basePts = cfg.factors.reduce((s, f) => s + (FACTOR_WEIGHTS[f] ?? 0), 0);
      personas.push({
        user_id:      userId,
        handle:       `bsim_${type.replace(/_/g, '')}_${String(idx).padStart(3, '0')}`,
        display_name: name,
        phone_e164:   `+2${String(2_000_000_000 + idx)}`,
        persona_type: type,
        trust_tier:   basePts >= 80 ? 'premium' : basePts >= 50 ? 'verified' : basePts >= 30 ? 'basic' : 'anonymous',
        trust_score:  basePts,
        discovery_mode: cfg.discovery,
        factors: cfg.factors,
      });
    }
  }
  return personas;
}

// ─── Helper: generate a day's call records ────────────────────────────────────

interface RawCall {
  caller_id: string;
  callee_id: string;
  status: 'missed' | 'ended' | 'declined';
  created_at: string;
}

function generateDayCalls(
  personas: BigPersona[],
  rng: Rng,
  dayOffset: number,         // hours before now for the day's start
  reviewedIds: Set<string>,
): RawCall[] {
  const calls: RawCall[] = [];
  const publicPersonas = personas.filter(p => p.discovery_mode === 'public');

  for (const caller of personas) {
    if (reviewedIds.has(caller.user_id)) continue;  // under review → can't call

    const cfg = PERSONA_CONFIGS[caller.persona_type];

    // Sleepers: spam on days 2+, normal on day 1
    const isSleeperSpam = caller.persona_type === 'sleeper' && dayOffset < 48;
    // Reformed: spam on day 1, normal on days 2+
    const isReformedSpam = caller.persona_type === 'reformed' && dayOffset >= 48;

    let callsToMake: number;
    let unknownRate: number;

    if (isSleeperSpam) {
      callsToMake = rng.int(35, 50);
      unknownRate = 1.0;
    } else if (isReformedSpam) {
      callsToMake = rng.int(0, 2);
      unknownRate = 0.1;
    } else {
      callsToMake = rng.int(...cfg.calls_per_day_range);
      unknownRate = cfg.unknown_call_rate;
    }

    const potentialCallees = rng.shuffle([...publicPersonas]).slice(0, callsToMake + 10);

    let made = 0;
    for (const callee of potentialCallees) {
      if (made >= callsToMake) break;
      if (callee.user_id === caller.user_id) continue;

      const isUnknown = rng.bool(unknownRate);
      const calleeCfg = PERSONA_CONFIGS[callee.persona_type];
      const answered = rng.bool(isUnknown ? calleeCfg.answer_incoming_rate * 0.6 : calleeCfg.answer_incoming_rate);
      const status: 'missed' | 'ended' | 'declined' = answered ? 'ended'
        : rng.bool(0.3) ? 'declined'
        : 'missed';

      // Timestamp: random within the day window
      const hoursFromNow = dayOffset - rng.next() * 24;
      const ts = new Date(Date.now() - hoursFromNow * 3_600_000).toISOString();

      calls.push({ caller_id: caller.user_id, callee_id: callee.user_id, status, created_at: ts });
      made++;
    }
  }
  return calls;
}

// ─── Bulk insert helpers ──────────────────────────────────────────────────────

async function bulkInsertCalls(calls: RawCall[]): Promise<void> {
  if (calls.length === 0) return;
  const BATCH = 300;
  for (let i = 0; i < calls.length; i += BATCH) {
    const batch = calls.slice(i, i + BATCH);
    const vals  = batch.map((_, j) => `($${j*5+1},$${j*5+2},'direct',$${j*5+3},$${j*5+4}::call_status,$${j*5+5},$${j*5+5})`).join(',');
    const args  = batch.flatMap(c => [c.caller_id, c.callee_id, crypto.randomBytes(8).toString('hex'), c.status, c.created_at]);
    await query(
      `INSERT INTO calls (caller_id,callee_id,call_type,webrtc_room_id,status,created_at,ended_at)
       VALUES ${vals}
       ON CONFLICT DO NOTHING`,
      args,
    );
  }
}

async function insertMassOutreachFlags(calls: RawCall[], dayTs: string): Promise<string[]> {
  // Count calls per caller in this day batch
  const countByCaller: Record<string, number> = {};
  for (const c of calls) {
    countByCaller[c.caller_id] = (countByCaller[c.caller_id] ?? 0) + 1;
  }
  const flagged: string[] = [];
  for (const [uid, cnt] of Object.entries(countByCaller)) {
    if (cnt >= 20) {
      await query(
        `INSERT INTO behavior_events (user_id, event_type, created_at) VALUES ($1, 'mass_outreach_flag', $2)`,
        [uid, dayTs],
      );
      flagged.push(uid);
    }
  }
  return flagged;
}

import { bulkComputeScores } from '../services/trustScore';

async function applyBulkScores(userIds: string[]): Promise<Map<string, number>> {
  const results = await bulkComputeScores(userIds);
  const scoreMap = new Map<string, number>();

  const BATCH = 100;
  for (let i = 0; i < results.length; i += BATCH) {
    const batch = results.slice(i, i + BATCH);
    // Bulk UPDATE with a VALUES list
    const caseWhen = batch.map((r, j) => `WHEN $${j * 3 + 1}::uuid THEN $${j * 3 + 2}::int`).join(' ');
    const caseWhenTier = batch.map((r, j) => `WHEN $${j * 3 + 1}::uuid THEN $${j * 3 + 3}::trust_tier`).join(' ');
    const args = batch.flatMap(r => [r.user_id, r.computed_score, r.tier]);
    await query(
      `UPDATE users SET trust_score = CASE user_id ${caseWhen} END,
                        trust_tier  = CASE user_id ${caseWhenTier} END
       WHERE user_id = ANY($${args.length + 1}::uuid[])`,
      [...args, batch.map(r => r.user_id)],
    );
    for (const r of batch) scoreMap.set(r.user_id, r.computed_score);
  }
  return scoreMap;
}

async function triggerReviews(userIds: string[], reviewedSet: Set<string>): Promise<string[]> {
  // Mark under review if score < 20 and not already
  const rows = await query<{ user_id: string; trust_score: number }>(
    `SELECT user_id, trust_score FROM users
     WHERE user_id = ANY($1::uuid[]) AND trust_score < 20 AND is_under_review = FALSE`,
    [userIds],
  );
  const newReviews: string[] = [];
  for (const r of rows) {
    await query(
      `UPDATE users SET is_under_review = TRUE,
        review_reason = $2, review_started_at = NOW()
       WHERE user_id = $1`,
      [r.user_id, `Trust score dropped to ${r.trust_score} — automatic review triggered.`],
    );
    reviewedSet.add(r.user_id);
    newReviews.push(r.user_id);
  }
  return newReviews;
}

// ─── Validation ───────────────────────────────────────────────────────────────

function buildValidation(
  personas: BigPersona[],
  finalScoreMap: Map<string, number>,
  reviewedIds: Set<string>,
  detectionDayMap: Map<string, number>,
): ValidationAssertion[] {
  const assertions: ValidationAssertion[] = [];

  for (const p of personas) {
    const cfg = PERSONA_CONFIGS[p.persona_type];
    const score = finalScoreMap.get(p.user_id) ?? 0;
    const isReviewed = reviewedIds.has(p.user_id);
    const [lo, hi] = cfg.expected_score_range;

    // Score range assertion
    const scoreOk = score >= lo && score <= hi;
    assertions.push({
      user_id: p.user_id,
      handle: p.handle,
      persona_type: p.persona_type,
      assertion: 'final_score_in_range',
      expected: `${lo}–${hi}`,
      actual: String(score),
      passed: scoreOk,
    });

    // Review assertion
    if (cfg.expected_under_review) {
      assertions.push({
        user_id: p.user_id,
        handle: p.handle,
        persona_type: p.persona_type,
        assertion: 'should_be_under_review',
        expected: 'true',
        actual: String(isReviewed),
        passed: isReviewed,
      });
    } else {
      // False positive check: should NOT be under review
      assertions.push({
        user_id: p.user_id,
        handle: p.handle,
        persona_type: p.persona_type,
        assertion: 'should_NOT_be_under_review',
        expected: 'false',
        actual: String(isReviewed),
        passed: !isReviewed,
      });
    }
  }
  return assertions;
}

// ─── POST /simulation/big-run ─────────────────────────────────────────────────

simulationRouter.post('/big-run', requireSimKey, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seed = typeof req.body?.seed === 'number' ? req.body.seed : 42;
    const rng = new Rng(seed);

    // ── Cleanup ────────────────────────────────────────────────────────────
    const existingIds = await query<{ user_id: string }>(
      `SELECT user_id FROM users WHERE handle LIKE 'bsim_%'`,
    );
    if (existingIds.length > 0) {
      const ids = existingIds.map(r => r.user_id);
      await query(`DELETE FROM behavior_events WHERE user_id = ANY($1::uuid[])`, [ids]);
      await query(`DELETE FROM trust_score_history WHERE user_id = ANY($1::uuid[])`, [ids]);
      await query(`DELETE FROM trust_factors WHERE user_id = ANY($1::uuid[])`, [ids]);
      await query(`DELETE FROM connections WHERE owner_id = ANY($1::uuid[]) OR contact_id = ANY($1::uuid[])`, [ids]);
      await query(`DELETE FROM calls WHERE caller_id = ANY($1::uuid[]) OR callee_id = ANY($1::uuid[])`, [ids]);
      await query(`DELETE FROM users WHERE user_id = ANY($1::uuid[])`, [ids]);
    }

    // ── Generate personas ──────────────────────────────────────────────────
    const personas = generatePersonas(rng);
    const allIds   = personas.map(p => p.user_id);

    // ── Insert users ───────────────────────────────────────────────────────
    const BATCH = 50;
    for (let i = 0; i < personas.length; i += BATCH) {
      const b = personas.slice(i, i + BATCH);
      const vals = b.map((_, j) => `($${j*9+1},$${j*9+2},$${j*9+3},$${j*9+4},$${j*9+5},$${j*9+6}::trust_tier,$${j*9+7},$${j*9+8},NOW()-INTERVAL '20 days',$${j*9+9})`).join(',');
      const args = b.flatMap(p => [
        p.user_id, p.phone_e164, sha256(p.phone_e164),
        p.handle, p.display_name,
        p.trust_tier, p.trust_score, p.discovery_mode, 'true',
      ]);
      await query(
        `INSERT INTO users (user_id,phone_e164,phone_hash,handle,display_name,trust_tier,trust_score,discovery_mode,created_at,is_active)
         VALUES ${vals}`,
        args,
      );
    }

    // ── Insert trust factors ───────────────────────────────────────────────
    const FACTOR_WEIGHTS: Record<string, number> = {
      phone_verified: 15, device_integrity: 10, liveness_check: 25, govt_id_verified: 30,
    };
    for (const p of personas) {
      for (const f of p.factors) {
        await query(
          `INSERT INTO trust_factors (user_id,factor_type,status,score_delta,verified_at)
           VALUES ($1,$2,'completed',$3,NOW()-INTERVAL '18 days')`,
          [p.user_id, f, FACTOR_WEIGHTS[f] ?? 0],
        );
      }
    }

    // ── Set up connections ─────────────────────────────────────────────────
    // power_users and normal_high users form trusted networks
    const powerAndHigh = personas.filter(p =>
      p.persona_type === 'power_user' || p.persona_type === 'normal_high'
    );
    for (const u of powerAndHigh) {
      // Each gets 3-6 trusted contacts from the same group
      const contacts = rng.shuffle([...powerAndHigh.filter(x => x.user_id !== u.user_id)]).slice(0, rng.int(3, 6));
      for (const c of contacts) {
        await query(
          `INSERT INTO connections (owner_id,contact_id,connection_type) VALUES ($1,$2,'trusted') ON CONFLICT DO NOTHING`,
          [u.user_id, c.user_id],
        );
      }
    }

    // personal_blocker: each gets blocked by 1-2 random normal users
    const normalUsers = personas.filter(p => p.persona_type === 'normal_low' || p.persona_type === 'normal_high');
    const blockers = personas.filter(p => p.persona_type === 'personal_blocker');
    for (const victim of blockers) {
      const blockerCount = rng.int(1, 2);
      for (let k = 0; k < blockerCount; k++) {
        const blocker = rng.pick(normalUsers);
        await query(
          `INSERT INTO connections (owner_id,contact_id,connection_type) VALUES ($1,$2,'blocked') ON CONFLICT DO NOTHING`,
          [blocker.user_id, victim.user_id],
        );
      }
    }

    const reviewedIds = new Set<string>();
    const detectionDayMap = new Map<string, number>();

    // ── Day 1 (T-72h to T-48h) ────────────────────────────────────────────
    const day1Calls = generateDayCalls(personas, rng, 60, reviewedIds);
    await bulkInsertCalls(day1Calls);
    const day1Flagged = await insertMassOutreachFlags(day1Calls, ago(54));
    const day1ScoreMap = await applyBulkScores(allIds);
    const day1NewReviews = await triggerReviews(allIds, reviewedIds);
    for (const uid of day1NewReviews) detectionDayMap.set(uid, 1);

    // ── Day 2 (T-48h to T-24h) ────────────────────────────────────────────
    const day2Calls = generateDayCalls(personas, rng, 36, reviewedIds);
    await bulkInsertCalls(day2Calls);
    const day2Flagged = await insertMassOutreachFlags(day2Calls, ago(30));
    const day2ScoreMap = await applyBulkScores(allIds);
    const day2NewReviews = await triggerReviews(allIds, reviewedIds);
    for (const uid of day2NewReviews) if (!detectionDayMap.has(uid)) detectionDayMap.set(uid, 2);

    // ── Day 3 (T-24h to now) ──────────────────────────────────────────────
    const day3Calls = generateDayCalls(personas, rng, 12, reviewedIds);
    await bulkInsertCalls(day3Calls);
    const day3Flagged = await insertMassOutreachFlags(day3Calls, ago(6));
    const finalScoreMap = await applyBulkScores(allIds);
    const day3NewReviews = await triggerReviews(allIds, reviewedIds);
    for (const uid of day3NewReviews) if (!detectionDayMap.has(uid)) detectionDayMap.set(uid, 3);

    // ── Assemble per-user log ──────────────────────────────────────────────
    const userLogs = personas.map(p => ({
      user_id:     p.user_id,
      handle:      p.handle,
      name:        p.display_name,
      persona_type: p.persona_type,
      day0_score:  p.trust_score,
      day1_score:  day1ScoreMap.get(p.user_id) ?? p.trust_score,
      day2_score:  day2ScoreMap.get(p.user_id) ?? p.trust_score,
      day3_score:  finalScoreMap.get(p.user_id) ?? p.trust_score,
      is_under_review: reviewedIds.has(p.user_id),
      detected_on_day: detectionDayMap.get(p.user_id) ?? null,
    }));

    // ── Validation ────────────────────────────────────────────────────────
    const assertions = buildValidation(personas, finalScoreMap, reviewedIds, detectionDayMap);
    const passed  = assertions.filter(a => a.passed).length;
    const failed  = assertions.filter(a => !a.passed).length;
    const failures = assertions.filter(a => !a.passed);

    // ── Summary stats ─────────────────────────────────────────────────────
    const badTypes = new Set<PersonaType>(['mass_spammer','harasser','scammer','sleeper','reformed']);
    const goodTypes = new Set<PersonaType>(['normal_low','normal_high','power_user','private_safe','passive','personal_blocker']);

    const badActors   = personas.filter(p => badTypes.has(p.persona_type));
    const goodActors  = personas.filter(p => goodTypes.has(p.persona_type));
    const tpReviewed  = badActors.filter(p => reviewedIds.has(p.user_id)).length;
    const fpReviewed  = goodActors.filter(p => reviewedIds.has(p.user_id)).length;

    const detectionTimes = [...detectionDayMap.values()];
    const avgDetectionDay = detectionTimes.length > 0
      ? (detectionTimes.reduce((a, b) => a + b, 0) / detectionTimes.length).toFixed(1)
      : 'N/A';

    const totalCalls = day1Calls.length + day2Calls.length + day3Calls.length;
    const blockedByReview = day2Calls.filter(c => reviewedIds.has(c.caller_id)).length
                          + day3Calls.filter(c => reviewedIds.has(c.caller_id)).length;

    res.json({
      ok: true,
      data: {
        meta: {
          total_users: personas.length,
          total_calls: totalCalls,
          seed,
          flagged_day1: day1Flagged.length,
          flagged_day2: day2Flagged.length,
          flagged_day3: day3Flagged.length,
        },
        summary: {
          accounts_under_review: reviewedIds.size,
          true_positive_rate_pct: badActors.length > 0
            ? Math.round(tpReviewed / badActors.length * 100)
            : 0,
          false_positive_rate_pct: goodActors.length > 0
            ? Math.round(fpReviewed / goodActors.length * 100)
            : 0,
          avg_detection_day: avgDetectionDay,
          calls_blocked_after_review: blockedByReview,
          validation_pass_rate_pct: Math.round(passed / (passed + failed) * 100),
        },
        validation: {
          passed, failed,
          pass_rate_pct: Math.round(passed / (passed + failed) * 100),
          failures: failures.slice(0, 20),  // cap to avoid huge payload
        },
        user_logs: userLogs,
        persona_summary: Object.fromEntries(
          (Object.keys(PERSONA_CONFIGS) as PersonaType[]).map(type => {
            const group = userLogs.filter(u => u.persona_type === type);
            const avgFinal = group.length > 0
              ? Math.round(group.reduce((s, u) => s + u.day3_score, 0) / group.length)
              : 0;
            const reviewedCount = group.filter(u => u.is_under_review).length;
            return [type, {
              count: group.length,
              avg_initial_score: Math.round(group.reduce((s, u) => s + u.day0_score, 0) / Math.max(1, group.length)),
              avg_day1_score:    Math.round(group.reduce((s, u) => s + u.day1_score, 0) / Math.max(1, group.length)),
              avg_day2_score:    Math.round(group.reduce((s, u) => s + u.day2_score, 0) / Math.max(1, group.length)),
              avg_final_score:   avgFinal,
              under_review:      reviewedCount,
              under_review_pct:  Math.round(reviewedCount / Math.max(1, group.length) * 100),
            }];
          })
        ),
      },
    });
  } catch (err: any) {
    // Return detailed error for simulation debugging
    res.status(500).json({ ok: false, error: { code: 'BIG_RUN_ERROR', message: err?.message ?? String(err), stack: err?.stack?.split('\n').slice(0, 5) } });
  }
});

// ─── POST /simulation/run-migrations ─────────────────────────────────────────
// One-shot: applies any pending schema migrations needed for simulation features.
// Safe to run multiple times (idempotent DDL).

simulationRouter.post('/run-migrations', requireSimKey, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS is_under_review    BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS review_reason      TEXT,
        ADD COLUMN IF NOT EXISTS review_started_at  TIMESTAMPTZ
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS idx_users_under_review
        ON users (is_under_review) WHERE is_under_review = TRUE
    `);
    res.json({ ok: true, message: 'Migrations applied.' });
  } catch (err) {
    next(err);
  }
});

// ─── GET /simulation/big-results ─────────────────────────────────────────────
// Returns current state of big-sim users (re-reads from DB)

simulationRouter.get('/big-results', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const key = req.query?.sim_key;
    if (key !== SIM_KEY) return next(new AppError(401, 'UNAUTHORIZED', 'Invalid simulation key.'));

    const users = await query<{
      handle: string; trust_score: number; trust_tier: string;
      is_under_review: boolean; review_reason: string | null;
    }>(
      `SELECT handle, trust_score, trust_tier, is_under_review, review_reason
       FROM users WHERE handle LIKE 'bsim_%' ORDER BY handle`,
    );
    res.json({ ok: true, data: { users, count: users.length } });
  } catch (err) {
    next(err);
  }
});
