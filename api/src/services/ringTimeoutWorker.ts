/**
 * ringTimeoutWorker.ts — in-process BullMQ consumer for call ring timeouts.
 *
 * The separate `worker` service historically shipped this, but it isn't running
 * the worker build in production, so stuck "ringing" rows were never cleaned up
 * server-side and every downstream call to that callee hit CALLEE_BUSY.
 *
 * Running the consumer inside the API guarantees the safety net exists whenever
 * the API is up: 45s after initiate, if a call is still initiated/ringing it is
 * marked `missed`, RTDB is updated (both devices drop instantly) and a cancel
 * push dismisses the callee's notification.
 *
 * initiate() enqueues `ring-timeout` jobs on the same queue/Redis.
 */
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { queryOne } from '@trustroute/shared';
import { isStreamBackedCall } from './directCallGates';
import { rtdbUpdateStatus, sendCallCancelledPush } from './fcm';
import { logger } from '../utils/logger';

let _worker: Worker | null = null;

function redisUrl(): string {
  return process.env.REDIS_PRIVATE_URL ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
}

export function startRingTimeoutWorker(): Worker | null {
  if (_worker) return _worker;

  // Workers need a dedicated blocking connection with retries disabled.
  const connection = new IORedis(redisUrl(), { maxRetriesPerRequest: null });

  _worker = new Worker<{ call_id: string }>(
    'ring-timeout',
    async (job) => {
      const { call_id } = job.data;

      const updated = await queryOne<{ callee_id: string; caller_id: string; webrtc_room_id: string | null }>(
        `UPDATE calls SET status = 'missed'::call_status, ended_at = NOW()
          WHERE call_id = $1 AND status IN ('initiated','ringing')
        RETURNING callee_id, caller_id, webrtc_room_id`,
        [call_id],
      );
      if (!updated) return;

      logger.debug('ringTimeout', `call ${call_id} timed out — marked missed`);

      if (isStreamBackedCall(updated.webrtc_room_id)) return;

      await rtdbUpdateStatus(call_id, 'missed').catch(() => {});

      // Dismiss the callee's incoming notification on background/killed devices.
      const callee = await queryOne<{ fcm_token: string | null }>(
        `SELECT fcm_token FROM users WHERE user_id = $1`,
        [updated.callee_id],
      );
      if (callee?.fcm_token) {
        await sendCallCancelledPush(callee.fcm_token, call_id, 'missed').catch(() => {});
      }
    },
    { connection, concurrency: 20 },
  );

  _worker.on('failed', (job, err) => {
    logger.warn('ringTimeout', `job ${job?.id} failed: ${err?.message ?? err}`);
  });

  logger.debug('ringTimeout', 'in-process ring-timeout worker started');
  return _worker;
}
