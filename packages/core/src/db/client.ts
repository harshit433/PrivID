/**
 * Drizzle client bound to the shared pg pool. Import `db` for typed queries and
 * `db.transaction(...)` for multi-statement writes. Raw SQL escape hatch: `sql`.
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getPool } from './pool';
import * as schema from './schema';

let instance: NodePgDatabase<typeof schema> | null = null;

export function getDb(): NodePgDatabase<typeof schema> {
  if (!instance) instance = drizzle(getPool(), { schema });
  return instance;
}

/** Convenience proxy so callers can `import { db } from '@trustroute/core'`. */
export const db: NodePgDatabase<typeof schema> = new Proxy({} as NodePgDatabase<typeof schema>, {
  get(_t, prop) {
    return getDb()[prop as keyof NodePgDatabase<typeof schema>];
  },
});

export type Database = NodePgDatabase<typeof schema>;
