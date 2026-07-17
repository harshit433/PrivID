/**
 * Notifications repository — per-device push registrations. One row per (user, hardware)
 * so re-installing updates the token in place. Push tokens live here, never on `users`.
 */
import { db, deviceRegistrations, users, eq, and, isNotNull, sql } from '@trustroute/core';

export type DeviceRow = typeof deviceRegistrations.$inferSelect;

export async function upsertDevice(input: {
  userId: string;
  platform: 'ios' | 'android';
  hardwareId: string;
  pushToken?: string | null;
  deviceFingerprint?: string | null;
  devicePubKey?: string | null;
}): Promise<DeviceRow> {
  const [row] = await db
    .insert(deviceRegistrations)
    .values({
      userId: input.userId,
      platform: input.platform,
      hardwareId: input.hardwareId,
      pushToken: input.pushToken ?? null,
      deviceFingerprint: input.deviceFingerprint ?? null,
      devicePubKey: input.devicePubKey ?? null,
    })
    .onConflictDoUpdate({
      target: [deviceRegistrations.userId, deviceRegistrations.hardwareId],
      set: {
        platform: input.platform,
        pushToken: input.pushToken ?? null,
        deviceFingerprint: input.deviceFingerprint ?? null,
        lastSeenAt: sql`now()`,
      },
    })
    .returning();
  return row!;
}

export async function listDevices(userId: string): Promise<DeviceRow[]> {
  return db.select().from(deviceRegistrations).where(eq(deviceRegistrations.userId, userId));
}

export async function removeDevice(userId: string, deviceId: string): Promise<boolean> {
  const rows = await db
    .delete(deviceRegistrations)
    .where(and(eq(deviceRegistrations.deviceId, deviceId), eq(deviceRegistrations.userId, userId)))
    .returning({ id: deviceRegistrations.deviceId });
  return rows.length > 0;
}

export async function pushTokensForUser(userId: string): Promise<string[]> {
  const rows = await db
    .select({ token: deviceRegistrations.pushToken })
    .from(deviceRegistrations)
    .where(and(eq(deviceRegistrations.userId, userId), isNotNull(deviceRegistrations.pushToken)));
  return rows.map((r) => r.token!).filter(Boolean);
}

/** Read a user's notification prefs blob (to honor per-category opt-outs). */
export async function notificationPrefs(userId: string): Promise<Record<string, unknown>> {
  const [row] = await db.select({ prefs: users.notificationPrefs }).from(users).where(eq(users.userId, userId)).limit(1);
  return (row?.prefs as Record<string, unknown>) ?? {};
}
