/**
 * Shared column builders so every table gets consistent id + timestamp columns.
 * `updated_at` is maintained by the shared trigger installed in the baseline
 * migration's post-step (see db/migrate + generated SQL), and touched by repos.
 */
import { sql } from 'drizzle-orm';
import { timestamp, uuid } from 'drizzle-orm/pg-core';

export const pk = () => uuid().primaryKey().defaultRandom();

export const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
export const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/** timestamptz column helper (nullable by default). */
export const ts = (name: string) => timestamp(name, { withTimezone: true });

export const now = sql`now()`;
