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
import { logger } from '../utils/logger';

// ── Singleton init ────────────────────────────────────────────────────────────

let _initialised = false;

function getApp(): admin.app.App | null {
  if (_initialised) return admin.apps[0] ?? null;

  const raw    = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const dbUrl  = process.env.FIREBASE_DATABASE_URL;

  if (!dbUrl) {
    logger.warn('Firebase', 'FIREBASE_DATABASE_URL not set — RTDB signaling will be disabled');
  }

  if (!raw) {
    logger.warn('Firebase', 'FIREBASE_SERVICE_ACCOUNT_JSON not set — FCM + RTDB disabled');
    _initialised = true;
    return null;
  }

  try {
    const serviceAccount = JSON.parse(raw);
    if (admin.apps.length === 0) {
      admin.initializeApp({
        credential:  admin.credential.cert(serviceAccount),
        databaseURL: dbUrl,
      });
    }
    _initialised = true;
    logger.debug('Firebase', 'Admin SDK initialised (FCM + RTDB)');
    return admin.apps[0] ?? null;
  } catch (err: any) {
    logger.error('Firebase', 'Failed to init Admin SDK:', err?.message);
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
    logger.warn('RTDB', 'rtdbCreateCall failed:', err?.message);
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
    logger.warn('RTDB', 'rtdbUpdateStatus failed:', err?.message);
  }
}

// ── RTDB — Activity Session Signaling ────────────────────────────────────────

export type ActivityAdapter = 'youtube' | 'screen_share';
export type ActivityStatus = 'active' | 'ended';

export interface ActivityParticipantSignal {
  user_id: string;
  handle: string;
  display_name: string;
  avatar_url?: string | null;
  role?: 'host' | 'participant';
}

export interface ActivitySessionSignal {
  activity_id: string;
  scope_type: 'direct' | 'group';
  scope_id: string;
  adapter: ActivityAdapter;
  status: ActivityStatus;
  livekit_room_id: string;
  host_user_id: string;
  controller_user_id: string;
  presenter_user_id?: string | null;
  created_by: string;
  created_at: number;
  state_revision: number;
  state: Record<string, unknown>;
  host: ActivityParticipantSignal;
}

export async function rtdbCreateActivitySession(payload: ActivitySessionSignal): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    const { host, ...session } = payload;
    await db.ref(`activities/${payload.activity_id}`).set({
      ...session,
      updated_at: Date.now(),
      participants: {
        [host.user_id]: {
          ...host,
          role: 'host',
          joined_at: Date.now(),
          active: true,
        },
      },
      messages: null,
    });
  } catch (err: any) {
    logger.warn('RTDB', 'rtdbCreateActivitySession failed:', err?.message);
  }
}

export async function rtdbUpdateActivityParticipant(
  activityId: string,
  participant: ActivityParticipantSignal,
  active: boolean,
): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db.ref(`activities/${activityId}/participants/${participant.user_id}`).update({
      ...participant,
      active,
      ...(active ? { joined_at: Date.now(), left_at: null } : { left_at: Date.now() }),
      updated_at: Date.now(),
    });
  } catch (err: any) {
    logger.warn('RTDB', 'rtdbUpdateActivityParticipant failed:', err?.message);
  }
}

export async function rtdbUpdateActivityControl(
  activityId: string,
  params: {
    host_user_id?: string;
    controller_user_id?: string;
    presenter_user_id?: string | null;
  },
): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db.ref(`activities/${activityId}`).update({
      ...params,
      updated_at: Date.now(),
    });
  } catch (err: any) {
    logger.warn('RTDB', 'rtdbUpdateActivityControl failed:', err?.message);
  }
}

export async function rtdbUpdateActivityState(
  activityId: string,
  state: Record<string, unknown>,
  revision: number,
): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db.ref(`activities/${activityId}`).update({
      state,
      state_revision: revision,
      updated_at: Date.now(),
    });
  } catch (err: any) {
    logger.warn('RTDB', 'rtdbUpdateActivityState failed:', err?.message);
  }
}

export async function rtdbAppendActivityMessage(
  activityId: string,
  message: {
    user_id: string;
    handle: string;
    display_name: string;
    text: string;
  },
): Promise<string | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const ref = db.ref(`activities/${activityId}/messages`).push();
    await ref.set({
      message_id: ref.key,
      ...message,
      created_at: Date.now(),
    });
    return ref.key;
  } catch (err: any) {
    logger.warn('RTDB', 'rtdbAppendActivityMessage failed:', err?.message);
    return null;
  }
}

export async function rtdbEndActivitySession(activityId: string): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db.ref(`activities/${activityId}`).update({
      status: 'ended',
      ended_at: Date.now(),
      updated_at: Date.now(),
    });
    setTimeout(async () => {
      try { await db.ref(`activities/${activityId}`).remove(); } catch { /* ignore */ }
    }, 10 * 60_000);
  } catch (err: any) {
    logger.warn('RTDB', 'rtdbEndActivitySession failed:', err?.message);
  }
}

// ── FCM — Incoming call wakeup push ──────────────────────────────────────────

export interface IncomingCallPayload {
  callId:          string;
  webrtcRoomId:    string;
  fromUserId:      string;
  handle:          string;
  displayName:     string;
  avatarUrl?:      string;
  trustTier:       string;
  trustScore:      number;
  connectionType?: string;
}

/**
 * Send a high-priority data-only FCM push to wake the callee's device.
 * RTDB handles real-time state after the device is awake.
 */
// ── FCM — Activity party wakeup push ─────────────────────────────────────────

export interface ActivityPartyPushPayload {
  activityId: string;
  adapter: ActivityAdapter;
  scopeType: 'direct' | 'group';
  scopeId: string;
  groupId?: string | null;
  otherUserId?: string | null;
  fromUserId: string;
  displayName: string;
  handle: string;
  title: string;
}

/**
 * Notify conversation participants that a party / watch-together session started.
 * Uses a notification message so it appears in the tray when the app is backgrounded.
 */
export async function sendActivityPartyPush(
  fcmToken: string,
  payload: ActivityPartyPushPayload,
): Promise<void> {
  const app = getApp();
  if (!app) return;

  const body =
    payload.adapter === 'screen_share'
      ? `${payload.displayName} started a screen share party`
      : `${payload.displayName} started Watch Together`;

  try {
    await app.messaging().send({
      token: fcmToken,
      notification: {
        title: payload.title,
        body,
      },
      data: {
        type: 'activity_party_started',
        activity_id: payload.activityId,
        adapter: payload.adapter,
        scope_type: payload.scopeType,
        scope_id: payload.scopeId,
        group_id: payload.groupId ?? '',
        other_user_id: payload.otherUserId ?? '',
        from_user_id: payload.fromUserId,
        display_name: payload.displayName,
        handle: payload.handle,
        title: payload.title,
      },
      android: {
        priority: 'high',
        notification: { channelId: 'activity_alerts' },
      },
      apns: {
        payload: { aps: { sound: 'default' } },
      },
    });
    logger.debug('FCM', `Activity party push sent → ${payload.activityId}`);
  } catch (err: any) {
    logger.warn('FCM', `Activity party push failed: ${err?.message}`);
  }
}

/**
 * Issue a Firebase custom auth token so the mobile client can read RTDB paths
 * gated by auth.uid (activities, calls).
 */
export async function createFirebaseCustomToken(userId: string): Promise<string | null> {
  const app = getApp();
  if (!app) return null;
  try {
    return await admin.auth().createCustomToken(userId);
  } catch (err: any) {
    logger.warn('Firebase', `createCustomToken failed: ${err?.message}`);
    return null;
  }
}

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
        type:             'incoming_call',
        call_id:          payload.callId,
        webrtc_room_id:   payload.webrtcRoomId,
        from_user_id:     payload.fromUserId,
        handle:           payload.handle,
        display_name:     payload.displayName,
        avatar_url:       payload.avatarUrl    ?? '',
        trust_tier:       payload.trustTier,
        trust_score:      String(payload.trustScore),
        connection_type:  payload.connectionType ?? '',
      },
      android: {
        priority: 'high',
        ttl:      0,  // drop if not delivered immediately
      },
      apns: {
        headers: {
          'apns-priority':   '10',
          'apns-push-type':  'background',
        },
        payload: {
          aps: {
            'content-available': 1,
            sound: 'default',
          },
        },
      },
    });
    logger.debug('FCM', `Wakeup push sent → call ${payload.callId}`);
  } catch (err: any) {
    const code: string = err?.errorInfo?.code ?? '';
    if (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token'
    ) {
      // Purge the stale token so future calls don't silently fail
      try {
        const { query: dbQuery } = await import('@trustroute/shared');
        await dbQuery(`UPDATE users SET fcm_token = NULL WHERE fcm_token = $1`, [fcmToken]);
      } catch { /* best effort */ }
    }
    logger.warn('FCM', `Push failed (${code || 'unknown'}): ${err?.message}`);
  }
}

// ── FCM — Call cancelled push ─────────────────────────────────────────────────

export async function sendCallCancelledPush(fcmToken: string, callId: string): Promise<void> {
  const app = getApp();
  if (!app) return;
  try {
    await app.messaging().send({
      token:   fcmToken,
      data:    { type: 'call_cancelled', call_id: callId },
      android: { priority: 'high', ttl: 0 },
      apns: {
        headers: { 'apns-priority': '10', 'apns-push-type': 'background' },
        payload: { aps: { 'content-available': 1 } },
      },
    });
  } catch (err: any) {
    const code: string = err?.errorInfo?.code ?? '';
    if (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token'
    ) {
      try {
        const { query: dbQuery } = await import('@trustroute/shared');
        await dbQuery(`UPDATE users SET fcm_token = NULL WHERE fcm_token = $1`, [fcmToken]);
      } catch { /* best effort */ }
    }
    logger.warn('FCM', `call_cancelled push failed: ${err?.message}`);
  }
}

// ── FCM — Admin / account notifications ───────────────────────────────────────

export type AdminNotificationType =
  | 'review_cleared'
  | 'warning'
  | 'restriction'
  | 'suspension';

const ADMIN_PUSH_TITLES: Record<AdminNotificationType, string> = {
  review_cleared: 'Account Update',
  warning:        'Account Warning',
  restriction:    'Account Restriction',
  suspension:     'Account Suspended',
};

/**
 * Send an account-status notification to a user via FCM.
 *
 * Uses a notification message (not data-only) so it appears in the system
 * notification tray even when the app is backgrounded.
 *
 * Errors are swallowed — failed push must never block the admin action.
 */
export async function sendAdminNotification(
  fcmToken: string,
  type:     AdminNotificationType,
  body:     string,
): Promise<void> {
  const app = getApp();
  if (!app) return;

  try {
    await app.messaging().send({
      token: fcmToken,
      notification: {
        title: ADMIN_PUSH_TITLES[type],
        body,
      },
      data: {
        type: `account_${type}`,
      },
      android: {
        priority: 'high',
        notification: { channelId: 'account_alerts' },
      },
      apns: {
        payload: { aps: { badge: 1, sound: 'default' } },
      },
    });
    logger.debug('FCM', `Admin notification sent: ${type}`);
  } catch (err: any) {
    logger.warn('FCM', `Admin notification push failed: ${err?.message}`);
  }
}
