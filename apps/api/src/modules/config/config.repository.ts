/**
 * Config repository — the feature-flag store (key → jsonb value). Small table, read on
 * nearly every app launch, so the service caches it.
 */
import { db, featureFlags, eq, sql } from '@trustroute/core';

export async function getAllFlags(): Promise<Record<string, unknown>> {
  const rows = await db.select().from(featureFlags);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function setFlag(key: string, value: unknown): Promise<void> {
  await db
    .insert(featureFlags)
    .values({ key, value: value as typeof featureFlags.$inferInsert['value'] })
    .onConflictDoUpdate({ target: featureFlags.key, set: { value: value as never, updatedAt: sql`now()` } });
}

export async function deleteFlag(key: string): Promise<void> {
  await db.delete(featureFlags).where(eq(featureFlags.key, key));
}
