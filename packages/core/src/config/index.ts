/**
 * Centralized, validated application configuration.
 *
 * Every environment variable the backend reads is declared here and parsed with
 * zod exactly once at process start. Essential settings (database, JWT verify key)
 * fail fast with a readable error; optional provider credentials are left absent so
 * the provider layer can fall back to its mock implementation in dev.
 *
 * Never read `process.env` anywhere else — import `config` instead.
 */
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? def : Number(v)))
    .pipe(z.number().int());

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(3000),

  // ── Data stores ──────────────────────────────────────────────────────────
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: int(40),
  REDIS_URL: z.string().optional(),
  REDIS_PRIVATE_URL: z.string().optional(),

  // ── Auth / JWT (RS256) ───────────────────────────────────────────────────
  JWT_PUBLIC_KEY_B64: z.string().optional(),
  JWT_PRIVATE_KEY_B64: z.string().optional(),
  JWT_PUBLIC_KEY_PATH: z.string().default('./keys/public.pem'),
  JWT_PRIVATE_KEY_PATH: z.string().default('./keys/private.pem'),
  JWT_ACCESS_TTL_SECONDS: int(60 * 60), // 1h
  JWT_REFRESH_TTL_SECONDS: int(30 * 24 * 60 * 60), // 30d
  JWT_ISSUER: z.string().default('trustroute'),

  ADMIN_API_KEY: z.string().optional(),

  // ── HTTP ─────────────────────────────────────────────────────────────────
  CORS_ALLOWED_ORIGINS: csv,
  API_BASE_URL: z.string().optional(),
  RAILWAY_PUBLIC_DOMAIN: z.string().optional(),
  JSON_LIMIT_DEFAULT: z.string().default('1mb'),
  JSON_LIMIT_LARGE: z.string().default('15mb'),

  // ── Feature toggles ──────────────────────────────────────────────────────
  ENABLE_SIMULATION: bool(false),
  MOCK_KYC: bool(false),
  MOCK_LIVENESS: bool(false),
  TELEPHONY_PROVIDER: z.string().default('mock'),

  // ── ML behavioural scoring (optional — absence => verification-only trust) ─
  ML_SERVICE_URL: z.string().optional(),
  ML_API_KEY: z.string().optional(),
  ML_TIMEOUT_MS: int(5000),

  // ── Providers (optional — absence => provider mock) ──────────────────────
  STREAM_API_KEY: z.string().optional(),
  STREAM_API_SECRET: z.string().optional(),

  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  FIREBASE_DATABASE_URL: z.string().optional(),

  SETU_DG_BASE_URL: z.string().optional(),
  SETU_DG_CLIENT_ID: z.string().optional(),
  SETU_DG_CLIENT_SECRET: z.string().optional(),
  SETU_DG_PRODUCT_INSTANCE_ID: z.string().optional(),
  SETU_DG_REDIRECT_URL: z.string().optional(),
  // India egress proxy — Setu geo-fences to India IPs; Railway is in Singapore, so
  // real DigiLocker calls route through a Mumbai proxy when this is set.
  SETU_DG_PROXY_BASE_URL: z.string().optional(),
  SETU_DG_PROXY_SECRET: z.string().optional(),

  LIVENESS_PROVIDER: z.string().optional(),
  LIVENESS_API_KEY: z.string().optional(),
  LUXAND_API_TOKEN: z.string().optional(),
  LIVENESS_BASE_URL: z.string().optional(),
  LIVENESS_CONFIDENCE_THRESHOLD: z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? 0.5 : Number(v)))
    .pipe(z.number()),
  FACE_MATCH_THRESHOLD: z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? 0.7 : Number(v)))
    .pipe(z.number()),

  EXOTEL_SID: z.string().optional(),
  EXOTEL_API_KEY: z.string().optional(),
  EXOTEL_API_TOKEN: z.string().optional(),
  EXOTEL_TOKEN: z.string().optional(),
  EXOTEL_SUBDOMAIN: z.string().optional(),
  EXOTEL_CALLER_ID: z.string().optional(),
  TELEPHONY_WEBHOOK_SECRET: z.string().optional(),

  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  RAZORPAYX_ACCOUNT_NUMBER: z.string().optional(),
  RAZORPAYX_WEBHOOK_SECRET: z.string().optional(),

  AWS_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  AWS_S3_BUCKET: z.string().optional(),
  S3_PUBLIC_BASE_URL: z.string().optional(),

  MSG91_AUTH_KEY: z.string().optional(),
});

export type AppConfig = z.infer<typeof envSchema> & {
  isProd: boolean;
  isDev: boolean;
  isTest: boolean;
};

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached) return cached;
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const data = parsed.data;
  cached = {
    ...data,
    isProd: data.NODE_ENV === 'production',
    isDev: data.NODE_ENV === 'development',
    isTest: data.NODE_ENV === 'test',
  };
  return cached;
}

/** Reset the memoized config — used by tests only. */
export function resetConfigForTests(): void {
  cached = null;
}

/**
 * Lazily-evaluated config proxy. Reads validate on first property access, so
 * importing this module never throws at import time (important for tooling).
 */
export const config: AppConfig = new Proxy({} as AppConfig, {
  get(_t, prop) {
    return loadConfig()[prop as keyof AppConfig];
  },
});
