/**
 * fcm.ts — Firebase services: Cloud Messaging + Realtime Database
 *
 * FCM: high-priority push to wake devices for incoming calls
 * RTDB: real-time call state signaling (sub-100ms, no polling needed)
 *
 * Environment variables:
 *   FIREBASE_SERVICE_ACCOUNT_JSON   full service account JSON
 *   FIREBASE_DATABASE_URL           RTDB URL  (e.g. https://privid-cb3bf-default-rtdb.firebaseio.com)
 */

import admin from 'firebase-admin';

// ── Singleton init ────────────────────────────────────────────────────────────

let _initialised = false;

function getApp(): admin.app.App | null {
  if (_initialised) return admin.apps[0] ?? null;

  const raw    = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const dbUrl  = process.env.FIREBASE_DATABASE_URL ?? 'https://privid-cb3bf-default-rtdb.firebaseio.com';

  if (!raw) {
    console.warn('[Firebase] FIREBASE_SERVICE_ACCOUNT_JSON not set — FCM + RTDB disabled');
    _initialised = true;
    return null;
  }

  try {
    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({
      credential:  admin.credential.cert(serviceAccount),
      databaseURL: dbUrl,
    });
    _initialised = true;
    console.log('[Firebase] Admin SDK initialised (FCM + RTDB)');
    return admin.apps[0] ?? null;
  } catch (err: any) {
    console.error('[Firebase] Failed to init Admin SDK:', err?.message);
    _initialised = true;
    return null;
  }
}

function getDb(): admin.database.Database | null {
  const app = getApp();
  if (!app) return null;
  try { return admin.database(); } catch { return null; }
}

// ── RTDB — Call Signaling ─────────────────────────────────────────────────────

/** Used by the debug health endpoint to verify RTDB connectivity. */
export async function testRtdbWrite(): Promise<void> {
  const db = getDb();
  if (!db) throw new Error('Firebase not initialised — check FIREBASE_SERVICE_ACCOUNT_JSON');
  await db.ref('_health').set({ ts: Date.now() });
}

export type CallSignalStatus =
  | 'ringing'   // call created, waiting for callee
  | 'answered'  // callee answered — LiveKit takes over
  | 'declined'  // callee explicitly declined
  | 'missed'    // caller cancelled / 45s timeout
  | 'ended'     // active call ended by either party
  | 'failed';   // connection/system error

/**
 * Write initial call entry to RTDB when a call is initiated.
 * Both devices subscribe to this path — any status change arrives instantly.
 */
export async function rtdbCreateCall(
  callId:   string,
  callerId: string,
  calleeId: string,
): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db.ref(`calls/${callId}`).set({
      status:     'ringing',
      caller_id:  callerId,
      callee_id:  calleeId,
      created_at: Date.now(),
    });
  } catch (err: any) {
    console.warn('[RTDB] rtdbCreateCall failed:', err?.message);
  }
}

/**
 * Update call status. Both caller and callee subscriptions fire immediately.
 */
export async function rtdbUpdateStatus(
  callId: string,
  status: CallSignalStatus,
): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db.ref(`calls/${callId}`).update({
      status,
      updated_at: Date.now(),
    });
    // Auto-delete 60s after terminal state to keep RTDB clean
    const terminal: CallSignalStatus[] = ['declined', 'missed', 'ended', 'failed'];
    if (terminal.includes(status)) {
      setTimeout(async () => {
        try { await db.ref(`calls/${callId}`).remove(); } catch { /* ignore */ }
      }, 60_000);
    }
  } catch (err: any) {
    console.warn('[RTDB] rtdbUpdateStatus failed:', err?.message);
  }
}

// ── FCM — Incoming call wakeup push ──────────────────────────────────────────

export interface IncomingCallPayload {
  callId:         string;
  fromUserId:     string;
  handle:         string;
  displayName:    string;
  avatarUrl?:     string;
  trustTier:      string;
  trustScore:     number;
  connectionType?: string;
}

/**
 * Send a high-priority data-only FCM push to wake the callee's device.
 * RTDB handles real-time state after the device is awake.
 */
export async function sendIncomingCallPush(
  fcmToken: string,
  payload:  IncomingCallPayload,
): Promise<void> {
  const app = getApp();
  if (!app) return;
  try {
    await app.messaging().send({
      token: fcmToken,
      data: {
        type:            'incoming_call',
        call_id:         payload.callId,
        from_user_id:    payload.fromUserId,
        handle:          payload.handle,
        display_name:    payload.displayName,
        avatar_url:      payload.avatarUrl    ?? '',
        trust_tier:      payload.trustTier,
        trust_score:     String(payload.trustScore),
        connection_type: payload.connectionType ?? '',
      },
      android: {
        priority: 'high',
        ttl:      30_000,
      },
    });
    console.log(`[FCM] Wakeup push sent → call ${payload.callId}`);
  } catch (err: any) {
    console.warn(`[FCM] Push failed: ${err?.message}`);
  }
}
