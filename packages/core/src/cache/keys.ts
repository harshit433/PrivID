/**
 * Central Redis key registry with documented TTLs. Nothing outside this file
 * should hand-write a key string — keeps naming consistent and greppable.
 */
export const TTL = {
  presence: 120, // NX gate: at most one last_seen write / 2 min / user
  trustScore: 5 * 60,
  shadowCaller: 10 * 60,
  featureFlags: 30,
  userProfile: 5 * 60,
  connectionList: 60,
  bizQr: 60,
  idempotency: 24 * 60 * 60,
} as const;

export const keys = {
  refreshToken: (tokenHash: string) => `refresh:${tokenHash}`,
  userSession: (userId: string) => `user:session:${userId}`,
  presence: (userId: string) => `presence:${userId}`,
  trustScore: (userId: string) => `trust_score:${userId}`,
  shadowCaller: (phoneHash: string) => `shadow:caller:${phoneHash}`,
  featureFlags: () => `config:feature_flags`,
  userProfile: (userId: string) => `user:profile:${userId}`,
  connectionList: (ownerId: string) => `connections:${ownerId}`,
  mlFeedbackSent: (userId: string) => `ml:feedback:${userId}`,
  bizQr: (token: string) => `biz_qr:${token}`,
  bizApiRate: (businessId: string) => `ratelimit:biz_api:${businessId}`,
  rateLimit: (bucket: string) => `rl:${bucket}`,
  idempotency: (userId: string, key: string) => `idem:${userId}:${key}`,
} as const;
