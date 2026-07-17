/**
 * Migration runner. Applies the Drizzle-generated SQL migrations in ./migrations.
 *
 *   npm run db:migrate            apply pending migrations
 *   npm run db:reset              DROP SCHEMA public + reapply from scratch (dev only)
 *
 * The baseline migration is produced by `npm run db:generate` from the schema in
 * src/db/schema. There is no hand-written migration SQL.
 */
import 'dotenv/config';
import path from 'path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDb } from './client';
import { getPool, closePool } from './pool';
import { config } from '../config';

async function main(): Promise<void> {
  // Reset drops + recreates the public schema. Guarded in prod: the `--reset` flag alone is
  // refused; a production wipe requires the explicit `DB_RESET=true` env opt-in (used once
  // during the v2 cutover, then removed) so a routine redeploy can never wipe data.
  const reset = process.argv.includes('--reset') || process.env.DB_RESET === 'true';
  if (reset) {
    if (config.isProd && process.env.DB_RESET !== 'true') throw new Error('Refusing to --reset in production without DB_RESET=true.');
    // eslint-disable-next-line no-console
    console.log('[migrate] resetting public schema…');
    await getPool().query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO PUBLIC;');
  }

  await ensureExtensions();

  const migrationsFolder = path.resolve(__dirname, 'migrations');
  // eslint-disable-next-line no-console
  console.log(`[migrate] applying migrations from ${migrationsFolder}`);
  await migrate(getDb(), { migrationsFolder });

  await installUpdatedAtTriggers();
  await ensureSearchIndexes();

  // eslint-disable-next-line no-console
  console.log('[migrate] done.');
}

/** Required Postgres extensions. Run before migrations (token defaults use pgcrypto). */
async function ensureExtensions(): Promise<void> {
  const pool = getPool();
  await pool.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);
  await pool.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm";`);
}

/**
 * Trigram + discovery search indexes. Kept as a post-step because GiST/trgm operator
 * classes aren't expressible in the Drizzle schema; idempotent and additive.
 */
async function ensureSearchIndexes(): Promise<void> {
  const pool = getPool();
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_handle_trgm ON users USING GiST (handle gist_trgm_ops);`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_users_display_name_trgm ON users USING GiST (display_name gist_trgm_ops) WHERE display_name IS NOT NULL;`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_users_discovery ON users (discovery_mode, is_active, handle) WHERE discovery_mode = 'public' AND is_active = TRUE;`,
  );
}

/**
 * Install the shared `set_updated_at` trigger on every table that has an `updated_at`
 * column. Idempotent — safe to run after each migrate. Drizzle-kit doesn't emit
 * triggers, so this keeps `updated_at` authoritative without per-repo boilerplate.
 */
async function installUpdatedAtTriggers(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
    BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
    $$ LANGUAGE plpgsql;
  `);
  const { rows } = await pool.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'updated_at'
  `);
  for (const { table_name } of rows) {
    const trigger = `trg_${table_name}_updated_at`;
    await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON "${table_name}";`);
    await pool.query(
      `CREATE TRIGGER ${trigger} BEFORE UPDATE ON "${table_name}" FOR EACH ROW EXECUTE FUNCTION set_updated_at();`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(`[migrate] updated_at triggers ensured on ${rows.length} tables`);
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error('[migrate] failed:', err instanceof Error ? err.message : err);
    await closePool();
    process.exit(1);
  });
