/**
 * Deterministic mock providers so the whole app runs end-to-end without Setu,
 * Exotel, Razorpay, S3, Firebase or Stream credentials. Selected automatically when
 * the corresponding credentials are absent (see ./index).
 */
import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../logger';
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

const rid = (p: string) => `${p}_${crypto.randomBytes(8).toString('hex')}`;

export const mockKycProvider: KycProvider = {
  mock: true,
  async createRequest(redirectUrl) {
    const requestId = rid('kyc');
    logger.debug('provider:kyc', 'mock createRequest', { requestId });
    // The app opens authUrl in a WebView; the mock immediately "returns" verified.
    return { requestId, authUrl: `${redirectUrl}?mock_request_id=${requestId}&status=success` };
  },
  async getStatus() {
    return { status: 'verified', providerRef: rid('setu') };
  },
  async fetchIdentity() {
    return {
      legalName: process.env.MOCK_KYC_NAME ?? 'Test User',
      maskedAadhaar: process.env.MOCK_KYC_AADHAAR ?? 'XXXXXXXX1234',
      dob: '1995-01-01',
    };
  },
};

export const mockLivenessProvider: LivenessProvider = {
  mock: true,
  available: () => true,
  async check() {
    return { pass: true, score: 0.99 };
  },
  async compareFaces() {
    return { match: true, score: 0.97 };
  },
};

export const mockTelephonyProvider: TelephonyProvider = {
  mock: true,
  async placeMaskedCall(input) {
    logger.debug('provider:telephony', 'mock placeMaskedCall', { virtual: input.virtualNumber });
    return { providerRef: rid('exo'), status: 'ringing' };
  },
  async endCall() {
    /* no-op */
  },
};

export const mockStreamProvider: StreamProvider = {
  configured: false,
  chatToken: (userId) => `mock-chat-token.${userId}`,
  videoToken: (userId) => `mock-video-token.${userId}`,
  async upsertUser() {
    /* no-op */
  },
  verifyWebhook: () => true,
};

export const mockPushProvider: PushProvider = {
  configured: false,
  async sendData(token) {
    logger.debug('provider:push', 'mock sendData', { token: token.slice(0, 8) });
  },
  async sendNotification(token, notification) {
    logger.debug('provider:push', 'mock sendNotification', { title: notification.title, token: token.slice(0, 8) });
  },
  async rtdbSet(path) {
    logger.debug('provider:push', 'mock rtdbSet', { path });
  },
};

export const mockPaymentsProvider: PaymentsProvider = {
  configured: false,
  async createOrder(input) {
    return { orderId: rid('order'), amountPaise: input.amountPaise };
  },
  verifyPaymentSignature: () => true,
  verifyWebhook: () => true,
};

export const mockPayoutsProvider: PayoutsProvider = {
  configured: false,
  async createPayout() {
    return { payoutRef: rid('pout'), status: 'processing' };
  },
};

export const mockStorageProvider: StorageProvider = {
  configured: false,
  async presignUpload(input) {
    const base = config.S3_PUBLIC_BASE_URL ?? 'https://mock-cdn.trustroute.dev';
    return { uploadUrl: `${base}/upload/${input.key}`, key: input.key, publicUrl: `${base}/${input.key}` };
  },
  async putObject(input) {
    // No real store in mock — callers should fall back to a data URL when needed.
    return { publicUrl: mockStorageProvider.publicUrl(input.key) };
  },
  publicUrl(key) {
    const base = config.S3_PUBLIC_BASE_URL ?? 'https://mock-cdn.trustroute.dev';
    return `${base}/${key}`;
  },
  async delete() {
    /* no-op */
  },
};
