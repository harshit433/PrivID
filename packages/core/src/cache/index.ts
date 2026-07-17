/**
 * Typed cache-aside helpers over Redis. Every cached entity should have a matching
 * `invalidate` call fired from its service on write — caching is opt-in and explicit,
 * never a hidden side effect.
 */
import { getRedis } from './redis';
import { logger } from '../logger';

export * from './redis';
export * from './keys';

/** JSON get. Returns null on miss or any Redis error (fail-open). */
export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const raw = await getRedis().get(key);
    return raw == null ? null : (JSON.parse(raw) as T);
  } catch (err) {
    logger.warn('cache', 'get failed', { key, error: (err as Error).message });
    return null;
  }
}

/** JSON set with TTL (seconds). Best-effort — never throws. */
export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    await getRedis().set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    logger.warn('cache', 'set failed', { key, error: (err as Error).message });
  }
}

/** Delete one or more keys. Best-effort. */
export async function cacheDel(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await getRedis().del(...keys);
  } catch (err) {
    logger.warn('cache', 'del failed', { keys, error: (err as Error).message });
  }
}

/**
 * Cache-aside wrapper: return cached value, else run `loader`, cache and return it.
 * A loader that throws is NOT cached and the error propagates.
 */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  const hit = await cacheGet<T>(key);
  if (hit !== null) return hit;
  const value = await loader();
  if (value !== null && value !== undefined) await cacheSet(key, value, ttlSeconds);
  return value;
}

/**
 * NX gate: returns true if the caller "won" the slot (key was absent and is now set
 * with the given TTL). Used for presence throttling and one-shot side effects.
 */
export async function acquireGate(key: string, ttlSeconds: number): Promise<boolean> {
  try {
    const res = await getRedis().set(key, '1', 'EX', ttlSeconds, 'NX');
    return res === 'OK';
  } catch {
    return false;
  }
}
