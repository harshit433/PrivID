import { getNotificationPrefs, type NotificationPrefs } from './userSettings';

export type NotificationCategory =
  | 'calls'
  | 'messages'
  | 'group_messages'
  | 'company_updates'
  | 'referral'
  | 'trust_security';

/** Returns false when the user has muted this category. trust_security always delivers. */
export async function shouldSendNotification(
  userId: string,
  category: NotificationCategory,
): Promise<boolean> {
  if (category === 'trust_security') return true;
  const prefs = await getNotificationPrefs(userId);
  return prefs[category] !== false;
}

export async function getUserNotificationPrefs(userId: string): Promise<NotificationPrefs> {
  return getNotificationPrefs(userId);
}
