import crypto from 'crypto';

/** SHA-256 hex digest of a raw API key (stored in businesses.api_key_hash). */
export function hashApiKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

/** Generate a new API key: `tr_live_` + 32 random bytes hex. */
export function generateApiKey(): { rawKey: string; keyHash: string } {
  const secret = crypto.randomBytes(32).toString('hex');
  const rawKey = `tr_live_${secret}`;
  return { rawKey, keyHash: hashApiKey(rawKey) };
}

export type BusinessPlan = 'starter' | 'growth' | 'enterprise';

export const PLAN_LIMITS: Record<
  BusinessPlan,
  { maxChannels: number; maxSubscribers: number; maxMessagesPerDay: number }
> = {
  starter:    { maxChannels: 3,  maxSubscribers: 5_000,   maxMessagesPerDay: 50 },
  growth:     { maxChannels: 10, maxSubscribers: 50_000,  maxMessagesPerDay: 500 },
  enterprise: { maxChannels: 50, maxSubscribers: 500_000, maxMessagesPerDay: 10_000 },
};
