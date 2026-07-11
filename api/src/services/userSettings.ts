import { query, queryOne } from '@trustroute/shared';
import type { UserRow } from '@trustroute/shared';
import { AppError } from '../middleware/errorHandler';

export interface NotificationPrefs {
  enabled: boolean;
  calls: boolean;
  messages: boolean;
  group_messages: boolean;
  company_updates: boolean;
  referral: boolean;
  trust_security: boolean;
  sound: boolean;
  vibrate: boolean;
}

export interface UserConsents {
  kyc_use: boolean;
  analytics_opt_out: boolean;
}

const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  enabled: true,
  calls: true,
  messages: true,
  group_messages: true,
  company_updates: true,
  referral: true,
  trust_security: true,
  sound: true,
  vibrate: true,
};

const DEFAULT_CONSENTS: UserConsents = {
  kyc_use: true,
  analytics_opt_out: false,
};

export function parseNotificationPrefs(raw: unknown): NotificationPrefs {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Partial<NotificationPrefs>;
  return { ...DEFAULT_NOTIFICATION_PREFS, ...obj };
}

export function parseUserConsents(raw: unknown): UserConsents {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Partial<UserConsents>;
  return { ...DEFAULT_CONSENTS, ...obj };
}

export async function getNotificationPrefs(userId: string): Promise<NotificationPrefs> {
  const row = await queryOne<{ notification_prefs: unknown }>(
    `SELECT notification_prefs FROM users WHERE user_id = $1`,
    [userId],
  );
  return parseNotificationPrefs(row?.notification_prefs);
}

export async function updateNotificationPrefs(
  userId: string,
  patch: Partial<NotificationPrefs>,
): Promise<NotificationPrefs> {
  const current = await getNotificationPrefs(userId);
  const next = { ...current, ...patch };
  await query(
    `UPDATE users SET notification_prefs = $2::jsonb, updated_at = NOW() WHERE user_id = $1`,
    [userId, JSON.stringify(next)],
  );
  return next;
}

export async function getUserConsents(userId: string): Promise<UserConsents> {
  const row = await queryOne<{ user_consents: unknown }>(
    `SELECT user_consents FROM users WHERE user_id = $1`,
    [userId],
  );
  return parseUserConsents(row?.user_consents);
}

export async function updateUserConsents(
  userId: string,
  patch: Partial<UserConsents>,
): Promise<UserConsents> {
  const current = await getUserConsents(userId);
  const next = { ...current, ...patch };
  await query(
    `UPDATE users SET user_consents = $2::jsonb, updated_at = NOW() WHERE user_id = $1`,
    [userId, JSON.stringify(next)],
  );
  return next;
}

export interface DiscoverySettings {
  discovery_mode: 'public' | 'private';
  contact_book_matching: boolean;
  show_trust_score: boolean;
}

export async function getDiscoverySettings(userId: string): Promise<DiscoverySettings> {
  const row = await queryOne<{
    discovery_mode: string;
    discovery_contact_book_matching: boolean;
    discovery_show_trust_score: boolean;
  }>(
    `SELECT discovery_mode, discovery_contact_book_matching, discovery_show_trust_score
       FROM users WHERE user_id = $1`,
    [userId],
  );
  if (!row) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
  return {
    discovery_mode: (row.discovery_mode as 'public' | 'private') ?? 'public',
    contact_book_matching: row.discovery_contact_book_matching ?? true,
    show_trust_score: row.discovery_show_trust_score ?? true,
  };
}

export async function updateDiscoverySettings(
  userId: string,
  patch: Partial<DiscoverySettings>,
): Promise<DiscoverySettings> {
  const current = await getDiscoverySettings(userId);
  const next = { ...current, ...patch };
  await query(
    `UPDATE users SET
       discovery_mode = $2,
       discovery_contact_book_matching = $3,
       discovery_show_trust_score = $4,
       updated_at = NOW()
     WHERE user_id = $1`,
    [userId, next.discovery_mode, next.contact_book_matching, next.show_trust_score],
  );
  return next;
}
