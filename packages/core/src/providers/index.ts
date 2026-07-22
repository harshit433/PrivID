/**
 * Provider factory. Each getter returns the real implementation when its credentials
 * are configured, otherwise a deterministic mock (dev/test only). Getters are memoized.
 *
 * In production, missing credentials throw unless MOCK_* is explicitly enabled.
 */
import { config } from '../config';
import { logger } from '../logger';
import * as mock from './mock';
import { setuKycProvider } from './setu';
import { luxandLivenessProvider } from './luxand';
import { exotelTelephonyProvider } from './exotel';
import { streamProvider } from './stream';
import { firebasePushProvider } from './firebase';
import { razorpayPaymentsProvider } from './razorpay';
import { razorpayxPayoutsProvider } from './razorpayx';
import { s3StorageProvider } from './s3';
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
export {
  createRazorpayContact,
  createFundAccountUpi,
  createFundAccountBank,
  verifyRazorpayXWebhookSignature,
} from './razorpayx';

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

function luxandToken(): string {
  return (config.LUXAND_API_TOKEN ?? config.LIVENESS_API_KEY ?? '').trim();
}

function exotelToken(): string {
  return (config.EXOTEL_API_TOKEN ?? config.EXOTEL_TOKEN ?? '').trim();
}

function s3Bucket(): string | undefined {
  return config.S3_BUCKET ?? config.AWS_S3_BUCKET;
}

function prodRequires(name: string, configured: boolean, mockFlag: boolean): void {
  if (config.isProd && !configured && !mockFlag) {
    throw new Error(`${name} is not configured for production. Set the required environment variables.`);
  }
}

// ── Configured-state predicates (also drive /health) ──────────────────────────
export const providerStatus = {
  streamConfigured: () => Boolean(config.STREAM_API_KEY && config.STREAM_API_SECRET),
  pushConfigured: () => Boolean(config.FIREBASE_SERVICE_ACCOUNT_JSON),
  kycConfigured: () =>
    Boolean(config.SETU_DG_CLIENT_ID && config.SETU_DG_CLIENT_SECRET && config.SETU_DG_PRODUCT_INSTANCE_ID),
  livenessConfigured: () => Boolean(luxandToken()),
  telephonyConfigured: () =>
    (config.TELEPHONY_PROVIDER ?? '').toLowerCase() === 'exotel' &&
    Boolean(config.EXOTEL_SID && config.EXOTEL_API_KEY && exotelToken()),
  paymentsConfigured: () => Boolean(config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET),
  payoutsConfigured: () =>
    Boolean(config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET && config.RAZORPAYX_ACCOUNT_NUMBER),
  storageConfigured: () =>
    Boolean(s3Bucket() && config.AWS_REGION && config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY),
};

export function kycIsMock(): boolean {
  if (config.MOCK_KYC) return true;
  return !providerStatus.kycConfigured();
}

export function livenessIsMock(): boolean {
  if (config.MOCK_LIVENESS) return true;
  if (config.isProd) return !providerStatus.livenessConfigured();
  return !providerStatus.livenessConfigured();
}

export function telephonyIsMock(): boolean {
  if ((config.TELEPHONY_PROVIDER ?? '').toLowerCase() === 'mock') return true;
  if (config.isProd) return !providerStatus.telephonyConfigured();
  return !providerStatus.telephonyConfigured();
}

// ── Getters ─────────────────────────────────────────────────────────────────
export const getKycProvider = memo<KycProvider>(() => {
  if (kycIsMock()) {
    prodRequires('DigiLocker (Setu)', providerStatus.kycConfigured(), config.MOCK_KYC);
    return mock.mockKycProvider;
  }
  logger.info('provider:kyc', 'using real Setu DigiLocker provider');
  return setuKycProvider;
});

export const getLivenessProvider = memo<LivenessProvider>(() => {
  if (livenessIsMock()) {
    prodRequires('Liveness (Luxand)', providerStatus.livenessConfigured(), config.MOCK_LIVENESS);
    return mock.mockLivenessProvider;
  }
  logger.info('provider:liveness', 'using real Luxand liveness provider');
  return luxandLivenessProvider;
});

export const getTelephonyProvider = memo<TelephonyProvider>(() => {
  if (telephonyIsMock()) {
    prodRequires('Telephony (Exotel)', providerStatus.telephonyConfigured(), false);
    return mock.mockTelephonyProvider;
  }
  logger.info('provider:telephony', 'using real Exotel provider');
  return exotelTelephonyProvider;
});

export const getStreamProvider = memo<StreamProvider>(() => {
  if (!providerStatus.streamConfigured()) {
    prodRequires('Stream', false, false);
    return mock.mockStreamProvider;
  }
  logger.info('provider:stream', 'using real Stream provider');
  return streamProvider;
});

export const getPushProvider = memo<PushProvider>(() => {
  if (!providerStatus.pushConfigured()) {
    prodRequires('Firebase', false, false);
    return mock.mockPushProvider;
  }
  logger.info('provider:push', 'using real Firebase provider');
  return firebasePushProvider;
});

export const getPaymentsProvider = memo<PaymentsProvider>(() => {
  if (!providerStatus.paymentsConfigured()) {
    prodRequires('Razorpay', false, false);
    return mock.mockPaymentsProvider;
  }
  logger.info('provider:payments', 'using real Razorpay provider');
  return razorpayPaymentsProvider;
});

export const getPayoutsProvider = memo<PayoutsProvider>(() => {
  if (!providerStatus.payoutsConfigured()) {
    prodRequires('RazorpayX', false, false);
    return mock.mockPayoutsProvider;
  }
  logger.info('provider:payouts', 'using real RazorpayX provider');
  return razorpayxPayoutsProvider;
});

export const getStorageProvider = memo<StorageProvider>(() => {
  if (!providerStatus.storageConfigured()) {
    prodRequires('S3', false, false);
    return mock.mockStorageProvider;
  }
  logger.info('provider:storage', 'using real S3 provider');
  return s3StorageProvider;
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
    telephony_configured: providerStatus.telephonyConfigured(),
    telephony_mock: telephonyIsMock(),
    payments_configured: providerStatus.paymentsConfigured(),
    payouts_configured: providerStatus.payoutsConfigured(),
    storage_configured: providerStatus.storageConfigured(),
  };
}
