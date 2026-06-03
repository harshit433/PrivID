/**
 * worker/src/queues.ts
 *
 * Central definition of every BullMQ queue and its job-data interface.
 *
 * Add new queues here — never instantiate Queue inside individual job files,
 * so the worker and any external enqueuers (API, scripts) share the exact
 * same queue names and connection.
 */

import { Queue } from 'bullmq';
import { getBullRedis } from './redis';

// ─── Queue instances ──────────────────────────────────────────────────────────

export const trustRecomputeQueue   = new Queue('trust-recompute',   { connection: getBullRedis() });
export const massOutreachQueue      = new Queue('mass-outreach',     { connection: getBullRedis() });
export const channelExpiryQueue     = new Queue('channel-expiry',    { connection: getBullRedis() });
export const connectionExpiryQueue  = new Queue('connection-expiry', { connection: getBullRedis() });
export const tokenRotationQueue     = new Queue('token-rotation',    { connection: getBullRedis() });
export const shadowRecomputeQueue   = new Queue('shadow-recompute',  { connection: getBullRedis() });
export const mlFeedbackQueue        = new Queue('ml-feedback',       { connection: getBullRedis() });
export const statusExpiryQueue      = new Queue('status-expiry',     { connection: getBullRedis() });
export const businessMessageDeliverQueue = new Queue('business-message-deliver', { connection: getBullRedis() });

// ─── Job data interfaces ──────────────────────────────────────────────────────

export interface TrustRecomputeJob {
  user_id: string;
  reason:  string;
}

export interface MassOutreachJob {
  user_id: string;
}

export interface ChannelExpiryJob {
  channel_id?: string;   // undefined = scan all expired channels
}

export interface ConnectionExpiryJob {
  // No payload — always scans all expired temporary connections
}

export interface TokenRotationJob {
  user_id?: string;      // undefined = scan all expired tokens
}

export interface ShadowRecomputeJob {
  // No payload — always performs a full incremental recompute
}

export interface MLFeedbackJob {
  // No payload — scans all high-block candidates
}

export interface StatusExpiryJob {
  // No payload — purges all expired status updates
}

export interface BusinessMessageDeliverJob {
  message_id: string;
}
