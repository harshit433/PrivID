/**
 * Config service: the client bootstrap payload (feature flags + a few static bits),
 * cached in Redis with explicit invalidation on write.
 */
import { cached, cacheDel, keys, TTL } from '@trustroute/core';
import * as repo from './config.repository';

export async function clientConfig() {
  const featureFlags = await cached(keys.featureFlags(), TTL.featureFlags, () => repo.getAllFlags());
  return { featureFlags, minSupportedVersion: (featureFlags.min_supported_version as string) ?? null };
}

export async function setFlag(key: string, value: unknown) {
  await repo.setFlag(key, value);
  await cacheDel(keys.featureFlags());
  return { key, value };
}

export async function deleteFlag(key: string) {
  await repo.deleteFlag(key);
  await cacheDel(keys.featureFlags());
  return { deleted: true };
}
