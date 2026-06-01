import Redis from 'ioredis';

let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });

    client.on('error', (err) => {
      console.error('[Redis] Connection error', err);
    });
  }
  return client;
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
  rateLimitSimSms: (phone: string) => `ratelimit:sim_sms:${phone}`,
};
