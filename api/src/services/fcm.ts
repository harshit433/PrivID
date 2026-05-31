/**
 * fcm.ts — Firebase Cloud Messaging service
 *
 * Sends high-priority data push notifications to Android devices.
 * Used exclusively for incoming call notifications so the device
 * wakes up regardless of whether the app is foreground/background/killed.
 *
 * Environment variable:
 *   FIREBASE_SERVICE_ACCOUNT_JSON  full contents of the Firebase service
 *                                  account JSON (from Firebase Console →
 *                                  Project Settings → Service Accounts →
 *                                  Generate new private key)
 *
 * Fail-open: if FCM is not configured the function logs a warning and
 * returns without throwing — the app falls back to its 3s polling loop.
 */

import admin from 'firebase-admin';

// ── Lazy singleton init ───────────────────────────────────────────────────────

let _initialised = false;

function getApp(): admin.app.App | null {
  if (_initialised) return admin.apps[0] ?? null;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    console.warn('[FCM] FIREBASE_SERVICE_ACCOUNT_JSON not set — push notifications disabled');
    _initialised = true;
    return null;
  }

  try {
    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    _initialised = true;
    console.log('[FCM] Firebase Admin SDK initialised');
    return admin.apps[0] ?? null;
  } catch (err: any) {
    console.error('[FCM] Failed to init Firebase Admin:', err?.message);
    _initialised = true;
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface IncomingCallPayload {
  callId:        string;
  fromUserId:    string;
  handle:        string;
  displayName:   string;
  avatarUrl?:    string;
  trustTier:     string;
  trustScore:    number;
  connectionType?: string;
}

/**
 * Send a high-priority incoming-call push to a specific FCM token.
 * Uses a data-only message so the app can handle it even when killed
 * and show its own full-screen call UI via notifee.
 */
export async function sendIncomingCallPush(
  fcmToken: string,
  payload: IncomingCallPayload,
): Promise<void> {
  const app = getApp();
  if (!app) return;   // FCM not configured — silent fallback

  try {
    await app.messaging().send({
      token: fcmToken,
      // data-only = no system tray notification; our app handles it
      data: {
        type:            'incoming_call',
        call_id:         payload.callId,
        from_user_id:    payload.fromUserId,
        handle:          payload.handle,
        display_name:    payload.displayName,
        avatar_url:      payload.avatarUrl   ?? '',
        trust_tier:      payload.trustTier,
        trust_score:     String(payload.trustScore),
        connection_type: payload.connectionType ?? '',
      },
      android: {
        priority: 'high',         // wakes device from doze
        ttl: 30_000,              // 30s — call will have expired after that
      },
    });
    console.log(`[FCM] Incoming call push sent for call ${payload.callId}`);
  } catch (err: any) {
    // Token may be stale — not fatal
    console.warn(`[FCM] Push send failed: ${err?.message}`);
  }
}
