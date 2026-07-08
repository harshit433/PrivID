import { Worker, Job } from 'bullmq';
import { getBullRedis } from '../redis';
import { query, queryOne } from '@trustroute/shared';
import { logger } from '../utils/logger';
import admin from 'firebase-admin';

const WORKER_NAME = 'ringTimeout';

let _fbInitialized = false;
function getFirebaseDb(): admin.database.Database | null {
  if (!_fbInitialized) {
    const raw   = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const dbUrl = process.env.FIREBASE_DATABASE_URL;
    if (raw && dbUrl && admin.apps.length === 0) {
      try {
        admin.initializeApp({
          credential:  admin.credential.cert(JSON.parse(raw)),
          databaseURL: dbUrl,
        });
      } catch { /* already initialized */ }
    }
    _fbInitialized = true;
  }
  if (!admin.apps.length) return null;
  try { return admin.database(); } catch { return null; }
}

export function startRingTimeoutWorker(): Worker {
  return new Worker<{ call_id: string }>(
    'ring-timeout',
    async (job: Job<{ call_id: string }>) => {
      const { call_id } = job.data;
      try {
        const updated = await queryOne<{ callee_id: string; caller_id: string }>(
          `UPDATE calls SET status = 'missed', ended_at = NOW()
           WHERE call_id = $1 AND status IN ('initiated', 'ringing')
           RETURNING callee_id, caller_id`,
          [call_id],
        );
        if (!updated) return; // already answered/ended — idempotent

        logger.debug(WORKER_NAME, `Ring timeout — call ${call_id} marked missed`);

        // Update RTDB for callee's active listener
        const db = getFirebaseDb();
        if (db) {
          await db.ref(`calls/${call_id}`).update({
            status:     'missed',
            updated_at: Date.now(),
          }).catch(() => {});

          // Auto-delete 60s later to keep RTDB clean
          setTimeout(async () => {
            try { await db.ref(`calls/${call_id}`).remove(); } catch { /* ignore */ }
          }, 60_000);
        }

        // Send cancellation FCM push to callee so background/killed devices dismiss the notification
        const callee = await queryOne<{ fcm_token: string | null }>(
          `SELECT fcm_token FROM users WHERE user_id = $1`,
          [updated.callee_id],
        );
        if (callee?.fcm_token && admin.apps.length > 0) {
          try {
            await admin.messaging().send({
              token:   callee.fcm_token,
              data:    { type: 'call_cancelled', call_id },
              android: { priority: 'high', ttl: 0 },
              apns: {
                headers: { 'apns-priority': '10', 'apns-push-type': 'background' },
                payload: { aps: { 'content-available': 1 } },
              },
            });
          } catch { /* best effort */ }
        }
      } catch (err: any) {
        logger.warn(WORKER_NAME, `Ring timeout error for call ${call_id}:`, err?.message);
        throw err; // BullMQ will retry
      }
    },
    { connection: getBullRedis(), concurrency: 20 },
  );
}
