/**
 * Idempotent dev/staging seed: feature flags + a dev virtual-number pool. Extended
 * in P1 once the schema tables exist. Safe to run repeatedly (ON CONFLICT DO NOTHING).
 */
import 'dotenv/config';
import { getPool, closePool } from './pool';

const FEATURE_FLAGS: Array<[string, string]> = [
  ['masked_calling_enabled', 'true'],
  ['telephony_provider_up', 'true'],
  ['per_minute_rate_paise', '70'],
  ['masked_daily_free_calls', '3'],
  ['masked_hold_minutes', '5'],
  ['referral_reward_paise', '3000'],
  ['referral_min_calls', '5'],
  ['referral_active_days', '30'],
  ['referral_min_withdrawal_paise', '10000'],
  ['handle_change_cooldown_days', '30'],
  ['data_export_sla_hours', '72'],
];

const DEV_NUMBERS = ['+918000000001', '+918000000002', '+918000000003'];

async function main(): Promise<void> {
  const pool = getPool();

  // These statements no-op cleanly if the tables don't exist yet (pre-P1).
  const hasFlags = await tableExists(pool, 'feature_flags');
  if (hasFlags) {
    for (const [key, value] of FEATURE_FLAGS) {
      await pool.query(
        `INSERT INTO feature_flags (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING`,
        [key, value],
      );
    }
    // eslint-disable-next-line no-console
    console.log(`[seed] feature flags ensured (${FEATURE_FLAGS.length})`);
  }

  const hasPool = await tableExists(pool, 'number_pool');
  if (hasPool) {
    for (const n of DEV_NUMBERS) {
      await pool.query(
        `INSERT INTO number_pool (virtual_number, provider, status) VALUES ($1, 'mock', 'active') ON CONFLICT (virtual_number) DO NOTHING`,
        [n],
      );
    }
    // eslint-disable-next-line no-console
    console.log(`[seed] dev number pool ensured (${DEV_NUMBERS.length})`);
  }
}

async function tableExists(pool: ReturnType<typeof getPool>, table: string): Promise<boolean> {
  const { rows } = await pool.query('SELECT to_regclass($1) AS reg', [`public.${table}`]);
  return Boolean(rows[0]?.reg);
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error('[seed] failed:', err instanceof Error ? err.message : err);
    await closePool();
    process.exit(1);
  });
