/**
 * Notifications service: manage device push registrations and fan a notification out to
 * a user's devices via the push provider (Firebase mock in dev). `notifyUser` is the
 * shared entry point other modules + the worker call.
 */
import { appError, getPushProvider, logger } from '@trustroute/core';
import * as repo from './notifications.repository';
import type { DeviceRow } from './notifications.repository';

function deviceView(d: DeviceRow) {
  return { deviceId: d.deviceId, platform: d.platform, hasPushToken: Boolean(d.pushToken), lastSeenAt: d.lastSeenAt, createdAt: d.createdAt };
}

export async function registerDevice(
  userId: string,
  input: { platform: 'ios' | 'android'; hardwareId: string; pushToken?: string; deviceFingerprint?: string; devicePubKey?: string },
) {
  const d = await repo.upsertDevice({ userId, ...input });
  return deviceView(d);
}

export async function listDevices(userId: string) {
  return { devices: (await repo.listDevices(userId)).map(deviceView) };
}

export async function unregister(userId: string, deviceId: string) {
  if (!(await repo.removeDevice(userId, deviceId))) throw appError('NOT_FOUND', 'Device not found.');
  return { removed: true };
}

/**
 * Fan a notification out to every registered device of `userId`, honoring the matching
 * notification-pref category. Best-effort per token; returns how many were sent.
 * Shared by other modules and the worker — not itself an HTTP handler.
 */
export async function notifyUser(
  userId: string,
  notification: { title: string; body: string },
  opts: { category?: string; data?: Record<string, string>; channelId?: string } = {},
): Promise<{ sent: number }> {
  if (opts.category) {
    const prefs = await repo.notificationPrefs(userId);
    if (prefs[opts.category] === false) return { sent: 0 };
  }
  const tokens = await repo.pushTokensForUser(userId);
  const push = getPushProvider();
  let sent = 0;
  for (const token of tokens) {
    try {
      await push.sendNotification(token, notification, opts.data, opts.channelId);
      sent++;
    } catch (err) {
      logger.warn('notifications', 'push send failed', { error: (err as Error).message });
    }
  }
  return { sent };
}

export async function sendTest(userId: string) {
  return notifyUser(userId, { title: 'TrustRoute', body: 'Notifications are working 🎉' }, { data: { type: 'test' } });
}
