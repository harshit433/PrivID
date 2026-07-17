/**
 * Provider factory. Each getter returns the real implementation when its credentials
 * are configured, otherwise a deterministic mock. Getters are memoized.
 *
 * Real implementations are added in their owning phase; until then a configured but
 * unimplemented provider still resolves to the mock (logged once) so nothing breaks.
 */
import { config } from '../config';
import { logger } from '../logger';
import * as mock from './mock';
import type {
  KycProvider,
  LivenessProvider,
  TelephonyProvider,
  StreamProvider,
  PushProvider,
  PaymentsProvider,
  PayoutsProvider,
  StorageProvider,
} from './types';

export * from './types';

function memo<T>(fn: () => T): () => T {
  let v: T | undefined;
  let set = false;
  return () => {
    if (!set) {
      v = fn();
      set = true;
    }
    return v as T;
  };
}

// ── Configured-state predicates (also drive /health) ──────────────────────────
export const providerStatus = {
  streamConfigured: () => Boolean(config.STREAM_API_KEY && config.STREAM_API_SECRET),
  pushConfigured: () => Boolean(config.FIREBASE_SERVICE_ACCOUNT_JSON),
  kycConfigured: () =>
    Boolean(config.SETU_DG_CLIENT_ID && config.SETU_DG_CLIENT_SECRET && config.SETU_DG_PRODUCT_INSTANCE_ID),
  livenessConfigured: () => Boolean(config.LIVENESS_API_KEY),
  telephonyConfigured: () => (config.TELEPHONY_PROVIDER ?? '').toLowerCase() === 'exotel' && Boolean(config.EXOTEL_API_KEY),
  paymentsConfigured: () => Boolean(config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET),
  payoutsConfigured: () => Boolean(config.RAZORPAY_KEY_ID && config.RAZORPAYX_ACCOUNT_NUMBER),
  storageConfigured: () => Boolean(config.S3_BUCKET && config.AWS_ACCESS_KEY_ID),
};

export function kycIsMock(): boolean {
  return config.MOCK_KYC || !providerStatus.kycConfigured();
}
export function livenessIsMock(): boolean {
  return config.MOCK_LIVENESS || !providerStatus.livenessConfigured();
}
export function telephonyIsMock(): boolean {
  return !providerStatus.telephonyConfigured();
}

// ── Getters (real impls plugged in per phase) ─────────────────────────────────
export const getKycProvider = memo<KycProvider>(() => {
  if (kycIsMock()) return mock.mockKycProvider;
  logger.warn('provider:kyc', 'real Setu provider not yet wired — using mock');
  return mock.mockKycProvider;
});

export const getLivenessProvider = memo<LivenessProvider>(() => {
  if (livenessIsMock()) return mock.mockLivenessProvider;
  logger.warn('provider:liveness', 'real liveness provider not yet wired — using mock');
  return mock.mockLivenessProvider;
});

export const getTelephonyProvider = memo<TelephonyProvider>(() => {
  if (telephonyIsMock()) return mock.mockTelephonyProvider;
  logger.warn('provider:telephony', 'real Exotel provider not yet wired — using mock');
  return mock.mockTelephonyProvider;
});

export const getStreamProvider = memo<StreamProvider>(() => {
  if (!providerStatus.streamConfigured()) return mock.mockStreamProvider;
  logger.warn('provider:stream', 'real Stream provider not yet wired — using mock');
  return mock.mockStreamProvider;
});

export const getPushProvider = memo<PushProvider>(() => {
  if (!providerStatus.pushConfigured()) return mock.mockPushProvider;
  logger.warn('provider:push', 'real Firebase provider not yet wired — using mock');
  return mock.mockPushProvider;
});

export const getPaymentsProvider = memo<PaymentsProvider>(() => {
  if (!providerStatus.paymentsConfigured()) return mock.mockPaymentsProvider;
  logger.warn('provider:payments', 'real Razorpay provider not yet wired — using mock');
  return mock.mockPaymentsProvider;
});

export const getPayoutsProvider = memo<PayoutsProvider>(() => {
  if (!providerStatus.payoutsConfigured()) return mock.mockPayoutsProvider;
  logger.warn('provider:payouts', 'real RazorpayX provider not yet wired — using mock');
  return mock.mockPayoutsProvider;
});

export const getStorageProvider = memo<StorageProvider>(() => {
  if (!providerStatus.storageConfigured()) return mock.mockStorageProvider;
  logger.warn('provider:storage', 'real S3 provider not yet wired — using mock');
  return mock.mockStorageProvider;
});

/** Provider snapshot for the /health endpoint. */
export function providerHealth(): Record<string, boolean> {
  return {
    stream_configured: providerStatus.streamConfigured(),
    push_configured: providerStatus.pushConfigured(),
    kyc_configured: providerStatus.kycConfigured(),
    kyc_mock: kycIsMock(),
    liveness_configured: providerStatus.livenessConfigured(),
    liveness_mock: livenessIsMock(),
    telephony_mock: telephonyIsMock(),
    payments_configured: providerStatus.paymentsConfigured(),
    payouts_configured: providerStatus.payoutsConfigured(),
    storage_configured: providerStatus.storageConfigured(),
  };
}
