import { Queue } from 'bullmq';
import { getBullRedis } from './redis';

export const trustRecomputeQueue = new Queue('trust-recompute', { connection: getBullRedis() });
export const massOutreachQueue   = new Queue('mass-outreach',   { connection: getBullRedis() });
export const channelExpiryQueue  = new Queue('channel-expiry',  { connection: getBullRedis() });
export const tokenRotationQueue  = new Queue('token-rotation',  { connection: getBullRedis() });

// ─── Job type interfaces ──────────────────────────────────────────────────────

export interface TrustRecomputeJob {
  user_id: string;
  reason: string;
}

export interface MassOutreachJob {
  user_id: string;
}

export interface ChannelExpiryJob {
  channel_id?: string;   // undefined = scan all
}

export interface TokenRotationJob {
  user_id?: string;      // undefined = scan all expired
}
