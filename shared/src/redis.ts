import Redis from 'ioredis';

let client: Redis | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Prefer Railway private networking when available. */
export function resolveRedisUrl(): string {
  return process.env.REDIS_PRIVATE_URL ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
}

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(resolveRedisUrl(), {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      connectTimeout: 10_000,
      retryStrategy: (times) => {
        if (times > 30) return null;
        return Math.min(times * 200, 3_000);
      },
      reconnectOnError: (err) => {
        const msg = err.message ?? '';
        return (
          msg.includes('READONLY') ||
          msg.includes('ECONNREFUSED') ||
          msg.includes('ETIMEDOUT') ||
          msg.includes('EHOSTUNREACH')
        );
      },
    });

    client.on('error', (err) => {
      // Transient during Railway redeploys — connectRedis() handles startup.
      console.error('[Redis] Connection error', err.message ?? err);
    });
  }
  return client;
}

/** Block until Redis accepts connections (Railway API often starts before Redis). */
export async function connectRedis(maxAttempts = 30, delayMs = 2_000): Promise<void> {
  const redis = getRedis();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (redis.status === 'wait' || redis.status === 'end') {
        await redis.connect();
      }
      await redis.ping();
      console.log(`[Redis] Connected (${attempt === 1 ? 'immediate' : `attempt ${attempt}`})`);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt >= maxAttempts) {
        throw new Error(`Redis unavailable after ${maxAttempts} attempts: ${message}`);
      }
      console.warn(`[Redis] Not ready (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms…`);
      await sleep(delayMs);
    }
  }
}

// Key helpers — centralized so nothing is spelled inconsistently
export const keys = {
  otpSession: (sessionId: string) => `otp:session:${sessionId}`,
  refreshToken: (tokenHash: string) => `refresh:${tokenHash}`,
  rateLimitOtp: (phone: string) => `ratelimit:otp:${phone}`,
  rateLimitCall: (userId: string, targetId: string) => `ratelimit:call:${userId}:${targetId}`,
  reachabilityToken: (token: string) => `reach:token:${token}`,
  userSession: (userId: string) => `user:session:${userId}`,
  /** Pending MSG91 signup after OTP verified (handle not chosen yet). TTL ~15 min. */
  msg91SignupPending: (signupToken: string) => `msg91:signup:${signupToken}`,
  /** SIM SMS binding challenge for authenticated user. TTL 2 min. */
  simSmsChallenge: (userId: string) => `sim_sms:${userId}`,
  /** SIM SMS send counter — per user, only incremented after successful delivery. TTL 15 min. */
  rateLimitSimSms: (userId: string) => `ratelimit:sim_sms:${userId}`,
  /**
   * Presence heartbeat debounce — written with NX + 120 s TTL.
   * If SET returns OK, the caller should also write last_seen_at to PostgreSQL.
   * If SET returns null (key existed), the DB was updated recently; skip.
   */
  presence: (userId: string) => `presence:${userId}`,
  /**
   * Shadow score feedback cooldown — prevents the same user being submitted
   * as an ML training label more than once per 7-day window.
   */
  mlFeedbackSent: (userId: string) => `ml:feedback:${userId}`,
  /** Single-use business QR scan token → user_id. TTL 60s. */
  bizQr: (token: string) => `biz_qr:${token}`,
  /** Business API rate limit bucket per verified business. */
  bizApiRate: (businessId: string) => `ratelimit:biz_api:${businessId}`,
};
