import { Worker, Job } from 'bullmq';
import { query, withTransaction } from '@trustroute/shared';
import type { TrustTier, UserRow } from '@trustroute/shared';
import type { TrustRecomputeJob } from '../queues';
import { getBullRedis } from '../redis';

// ─── Trust score logic (mirrors api/services/trustScore.ts) ──────────────────
// Duplicated here so the worker is self-contained with no circular dep on the api package

const FACTOR_WEIGHTS: Record<string, number> = {
  phone_verified: 15,
  device_integrity: 10,
  liveness_check: 25,
  govt_id_verified: 30,
  profile_complete: 5,
  account_age: 5,
  network_trust: 10,
  behavior_modifier: 0,
};

function scoreToTier(score: number): TrustTier {
  if (score >= 80) return 'premium';
  if (score >= 50) return 'verified';
  if (score >= 30) return 'basic';
  return 'anonymous';
}

async function computeScore(userId: string): Promise<{ total: number; tier: TrustTier }> {
  // Completed factors
  const completedRows = await query(
    `SELECT factor_type FROM trust_factors WHERE user_id = $1 AND status = 'completed'`,
    [userId]
  );
  const completed = new Set(completedRows.map((r) => r.factor_type));

  // Profile completeness
  const user = await query<UserRow>(
    `SELECT display_name, avatar_url, created_at FROM users WHERE user_id = $1`,
    [userId]
  );
  const profileDone = !!(user[0]?.display_name && user[0]?.avatar_url);
  const ageDays = user[0]
    ? Math.floor((Date.now() - new Date(user[0].created_at).getTime()) / 86400000)
    : 0;

  // Network trust
  const [netRow] = await query<{ avg_score: string }>(
    `SELECT COALESCE(AVG(u.trust_score), 0)::numeric(5,2) AS avg_score
     FROM connections c JOIN users u ON u.user_id = c.contact_id
     WHERE c.owner_id = $1 AND c.connection_type = 'trusted'`,
    [userId]
  );
  const networkScore = Math.min(10, Math.round((parseFloat(netRow?.avg_score ?? '0') / 70) * 10));

  // Behavior penalty
  const [blocks] = await query<{ count: string }>(
    `SELECT COUNT(*)::text as count FROM connections
     WHERE contact_id = $1 AND connection_type = 'blocked' AND updated_at > NOW() - INTERVAL '30 days'`,
    [userId]
  );
  const [flags] = await query<{ count: string }>(
    `SELECT COUNT(*)::text as count FROM behavior_events
     WHERE user_id = $1 AND event_type = 'mass_outreach_flag' AND created_at > NOW() - INTERVAL '30 days'`,
    [userId]
  );
  const penalty = Math.min(20, Math.min(15, parseInt(blocks.count) * 3) + Math.min(20, parseInt(flags.count) * 5));

  const raw =
    (completed.has('phone_verified')   ? FACTOR_WEIGHTS.phone_verified   : 0) +
    (completed.has('device_integrity') ? FACTOR_WEIGHTS.device_integrity  : 0) +
    (completed.has('liveness_check')   ? FACTOR_WEIGHTS.liveness_check    : 0) +
    (completed.has('govt_id_verified') ? FACTOR_WEIGHTS.govt_id_verified  : 0) +
    (profileDone                        ? FACTOR_WEIGHTS.profile_complete  : 0) +
    Math.min(5, Math.round((ageDays / 180) * 5)) +
    networkScore +
    (-penalty);

  const total = Math.max(0, Math.min(100, raw));
  return { total, tier: scoreToTier(total) };
}

// ─── Worker ───────────────────────────────────────────────────────────────────

export function startTrustRecomputeWorker() {
  const worker = new Worker<TrustRecomputeJob>(
    'trust-recompute',
    async (job: Job<TrustRecomputeJob>) => {
      const { user_id, reason } = job.data;
      console.log(`[trust-recompute] Processing user ${user_id} — reason: ${reason}`);

      const { total, tier } = await computeScore(user_id);

      await withTransaction(async (client) => {
        const { rows } = await client.query<UserRow>(
          `SELECT trust_score, trust_tier FROM users WHERE user_id = $1 FOR UPDATE`,
          [user_id]
        );
        const current = rows[0];
        if (!current) return;

        await client.query(
          `UPDATE users SET trust_score = $1, trust_tier = $2 WHERE user_id = $3`,
          [total, tier, user_id]
        );

        if (current.trust_score !== total || current.trust_tier !== tier) {
          await client.query(
            `INSERT INTO trust_score_history (user_id, old_score, new_score, old_tier, new_tier, reason)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [user_id, current.trust_score, total, current.trust_tier, tier, reason]
          );
          console.log(`[trust-recompute] ${user_id}: ${current.trust_score}→${total} (${current.trust_tier}→${tier})`);
        }
      });
    },
    {
      connection: getBullRedis(),
      concurrency: 5,
    }
  );

  worker.on('failed', (job, err) => {
    console.error(`[trust-recompute] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}
