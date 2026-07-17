/**
 * Central BullMQ queue registry + typed job payloads. The API enqueues; the worker
 * processes. Both import queue names + job types from here so they can never drift.
 *
 * BullMQ requires its own ioredis connection with `maxRetriesPerRequest: null`, kept
 * separate from the app cache client.
 */
import { Queue, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import { resolveRedisUrl } from '../cache/redis';

let bullConnection: IORedis | null = null;

export function getBullConnection(): ConnectionOptions {
  if (!bullConnection) {
    bullConnection = new IORedis(resolveRedisUrl(), {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }
  return bullConnection;
}

export const QUEUE = {
  trustRecompute: 'trust-recompute',
  massOutreach: 'mass-outreach',
  channelExpiry: 'channel-expiry',
  connectionExpiry: 'connection-expiry',
  tokenRotation: 'token-rotation',
  shadowRecompute: 'shadow-recompute',
  mlFeedback: 'ml-feedback',
  statusExpiry: 'status-expiry',
  businessMessageDeliver: 'business-message-deliver',
  ringTimeout: 'ring-timeout',
  referralQualification: 'referral-qualification',
  handlePropagation: 'handle-propagation',
  dataExport: 'data-export',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

// ── Job payloads ────────────────────────────────────────────────────────────
export interface TrustRecomputeJob { user_id: string; reason: string }
export interface MassOutreachJob { user_id: string }
export interface ChannelExpiryJob { channel_id?: string }
export interface ConnectionExpiryJob { _?: never }
export interface TokenRotationJob { user_id?: string }
export interface ShadowRecomputeJob { _?: never }
export interface MLFeedbackJob { _?: never }
export interface StatusExpiryJob { _?: never }
export interface BusinessMessageDeliverJob { message_id: string }
export interface RingTimeoutJob { call_id: string }
export interface ReferralQualificationJob { _?: never }
export interface HandlePropagationJob { job_id: string; user_id: string }
export interface DataExportJob { request_id: string; user_id: string }

export interface JobMap {
  'trust-recompute': TrustRecomputeJob;
  'mass-outreach': MassOutreachJob;
  'channel-expiry': ChannelExpiryJob;
  'connection-expiry': ConnectionExpiryJob;
  'token-rotation': TokenRotationJob;
  'shadow-recompute': ShadowRecomputeJob;
  'ml-feedback': MLFeedbackJob;
  'status-expiry': StatusExpiryJob;
  'business-message-deliver': BusinessMessageDeliverJob;
  'ring-timeout': RingTimeoutJob;
  'referral-qualification': ReferralQualificationJob;
  'handle-propagation': HandlePropagationJob;
  'data-export': DataExportJob;
}

const queues = new Map<QueueName, Queue>();

/** Get (memoized) a typed queue. */
export function getQueue<N extends QueueName>(name: N): Queue<JobMap[N]> {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: getBullConnection() });
    queues.set(name, q);
  }
  return q as Queue<JobMap[N]>;
}

/** Enqueue a job with optional dedupe jobId. */
export async function enqueue<N extends QueueName>(
  name: N,
  data: JobMap[N],
  opts?: { jobId?: string; delayMs?: number },
): Promise<void> {
  // BullMQ derives the job-name type from the data via a conditional that can't be
  // resolved under a generic parameter, so we call add through a concrete signature.
  const q = getQueue(name);
  const add = q.add.bind(q) as (n: string, d: JobMap[N], o: Record<string, unknown>) => Promise<unknown>;
  await add(name, data, {
    jobId: opts?.jobId,
    delay: opts?.delayMs,
    removeOnComplete: 1000,
    removeOnFail: 5000,
  });
}
