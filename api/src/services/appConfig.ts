import { query, queryOne } from '@trustroute/shared';

export type TopUpPack = {
  id: string;
  amount_paise: number;
  minutes: number;
  label: string;
  best_value?: boolean;
};

export const DEFAULT_PACKS: TopUpPack[] = [
  { id: 'pack_49', amount_paise: 4_900, minutes: 70, label: '₹49' },
  { id: 'pack_99', amount_paise: 9_900, minutes: 150, label: '₹99', best_value: true },
  { id: 'pack_199', amount_paise: 19_900, minutes: 320, label: '₹199' },
];

const DEFAULT_RATE_PAISE = 70;
const DEFAULT_DAILY_FREE = 3;
const DEFAULT_HOLD_MINUTES = 5;

async function flagValue<T>(key: string, fallback: T): Promise<T> {
  const row = await queryOne<{ value: unknown }>(
    `SELECT value FROM feature_flags WHERE key = $1`,
    [key],
  );
  if (!row) return fallback;
  const v = row.value;
  if (typeof v === 'string') {
    try { return JSON.parse(v) as T; } catch { return v as T; }
  }
  return v as T;
}

export async function getPerMinuteRatePaise(): Promise<number> {
  const v = await flagValue<number>('per_minute_rate_paise', DEFAULT_RATE_PAISE);
  return typeof v === 'number' && v > 0 ? v : DEFAULT_RATE_PAISE;
}

export async function getMaskedDailyFreeCalls(): Promise<number> {
  const v = await flagValue<number>('masked_daily_free_calls', DEFAULT_DAILY_FREE);
  return typeof v === 'number' && v >= 0 ? v : DEFAULT_DAILY_FREE;
}

export async function getMaskedHoldMinutes(): Promise<number> {
  const v = await flagValue<number>('masked_hold_minutes', DEFAULT_HOLD_MINUTES);
  return typeof v === 'number' && v > 0 ? v : DEFAULT_HOLD_MINUTES;
}

export async function isMaskedCallingEnabled(): Promise<boolean> {
  const v = await flagValue<boolean | string>('masked_calling_enabled', true);
  return v === true || v === 'true';
}

export async function isTelephonyUp(): Promise<boolean> {
  const v = await flagValue<boolean | string>('telephony_provider_up', true);
  return v === true || v === 'true';
}

export function paiseToMinutes(balancePaise: number, ratePaise: number): number {
  if (ratePaise <= 0) return 0;
  return Math.floor(balancePaise / ratePaise);
}

export function estimateCostPaise(seconds: number, ratePaise: number): number {
  const minutes = Math.ceil(seconds / 60);
  return minutes * ratePaise;
}

export async function getAppConfig() {
  const [rate, packs, maskedEnabled, telephonyUp, dailyFree, holdMin] = await Promise.all([
    getPerMinuteRatePaise(),
    Promise.resolve(DEFAULT_PACKS),
    isMaskedCallingEnabled(),
    isTelephonyUp(),
    getMaskedDailyFreeCalls(),
    getMaskedHoldMinutes(),
  ]);

  return {
    per_minute_rate_paise: rate,
    wallet_packs: packs,
    feature_flags: {
      masked_calling_enabled: maskedEnabled,
      telephony_provider_up: telephonyUp,
    },
    masked: {
      daily_free_calls: dailyFree,
      hold_minutes: holdMin,
    },
    native_chat_enabled: await flagValue<boolean | string>('native_chat_enabled', true),
  };
}

export async function seedFeatureFlag(key: string, value: unknown): Promise<void> {
  await query(
    `INSERT INTO feature_flags (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)],
  );
}
