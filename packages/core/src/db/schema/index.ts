/**
 * Drizzle schema barrel — the single source of truth for the database. The generated
 * baseline migration and every typed repository derive from these definitions.
 *
 * `updated_at` columns are auto-maintained by the `set_updated_at` trigger installed
 * as a post-step in db/migrate.ts (applied to every table that has the column).
 */
export * from './_enums';
export * from './identity';
export * from './users';
export * from './trust';
export * from './connections';
export * from './reachability';
export * from './calls';
export * from './masked';
export * from './wallet';
export * from './chat';
export * from './status';
export * from './activities';
export * from './business';
export * from './referrals';
export * from './moderation';
export * from './system';
