import { Pool, PoolClient } from 'pg';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // 40 connections: enough headroom for concurrent call initiations + background jobs
      // without exhausting Railway's Postgres connection limit (~100 on most plans).
      max: 40,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      // Keep connections warm — avoids TCP handshake on cold slots under burst traffic.
      allowExitOnIdle: false,
    });

    pool.on('error', (err) => {
      console.error('[DB] Unexpected pool error', err);
    });
  }
  return pool;
}

export async function query<T = any>(
  sql: string,
  params?: any[]
): Promise<T[]> {
  const result = await getPool().query(sql, params);
  return result.rows as T[];
}

export async function queryOne<T = any>(
  sql: string,
  params?: any[]
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '10s'");
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
