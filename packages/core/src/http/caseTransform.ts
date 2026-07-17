/**
 * Wire-format case transform. Internally the codebase is camelCase; the mobile client's
 * contract (screens, stores, types) is snake_case — the same shape the legacy backend
 * emitted. Rather than churn either side, we translate at the HTTP boundary: responses
 * go camelCase → snake_case, request bodies go snake_case → camelCase.
 *
 * OPAQUE_KEYS name fields whose *values* are semantic maps (jsonb blobs keyed by
 * business-meaningful strings — notification categories, feature-flag names, arbitrary
 * metadata). We rename the key itself but never recurse into the value, so a preference
 * like `company_updates` is never mangled into `companyUpdates`.
 */
const OPAQUE_KEYS = new Set([
  'metadata',
  'milestones',
  'details',
  'mock',
  'notificationPrefs',
  'notification_prefs',
  'userConsents',
  'user_consents',
  'integrityVerdict',
  'integrity_verdict',
  'featureFlags',
  'feature_flags',
]);

const snakeCache = new Map<string, string>();
const camelCache = new Map<string, string>();

function toSnake(key: string): string {
  const hit = snakeCache.get(key);
  if (hit !== undefined) return hit;
  const out = key.replace(/([A-Z])/g, '_$1').replace(/__+/g, '_').toLowerCase();
  snakeCache.set(key, out);
  return out;
}

function toCamel(key: string): string {
  const hit = camelCache.get(key);
  if (hit !== undefined) return hit;
  const out = key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
  camelCache.set(key, out);
  return out;
}

function transform(value: unknown, rename: (k: string) => string): unknown {
  if (Array.isArray(value)) return value.map((v) => transform(v, rename));
  if (value === null || typeof value !== 'object') return value;
  // Preserve Date, Buffer, etc. — only plain objects get their keys rewritten.
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[rename(k)] = OPAQUE_KEYS.has(k) ? v : transform(v, rename);
  }
  return out;
}

/** Deep camelCase → snake_case for outgoing response payloads. */
export function toSnakeCaseDeep<T>(value: T): T {
  return transform(value, toSnake) as T;
}

/** Deep snake_case → camelCase for incoming request bodies. */
export function toCamelCaseDeep<T>(value: T): T {
  return transform(value, toCamel) as T;
}
