/**
 * External-provider interfaces. Domain services depend on these abstractions, never
 * on a vendor SDK directly, so any provider can be swapped for its mock in dev/test.
 * Real implementations are added per phase; mocks live in ./mock.
 */

// ── KYC / DigiLocker (Setu) ───────────────────────────────────────────────────
export interface KycRequest {
  requestId: string;
  authUrl: string;
}
export interface KycStatus {
  status: 'pending' | 'verified' | 'failed' | 'expired';
  providerRef?: string;
}
export interface KycIdentity {
  legalName: string;
  maskedAadhaar: string;
  dob?: string;
  photoBase64?: string;
}
export interface KycProvider {
  readonly mock: boolean;
  createRequest(redirectUrl: string): Promise<KycRequest>;
  getStatus(requestId: string): Promise<KycStatus>;
  fetchIdentity(requestId: string): Promise<KycIdentity>;
}

// ── Liveness / face match (3DiVi / Luxand) ────────────────────────────────────
export interface LivenessResult {
  pass: boolean;
  score: number;
  reason?: string;
}
export interface FaceMatchResult {
  match: boolean;
  score: number;
}
export interface LivenessProvider {
  readonly mock: boolean;
  available(): boolean;
  check(selfieBase64: string): Promise<LivenessResult>;
  compareFaces(aBase64: string, bBase64: string): Promise<FaceMatchResult>;
}

// ── Telephony / masked calling (Exotel) ───────────────────────────────────────
export interface MaskedCallHandle {
  providerRef: string;
  status: 'placing' | 'ringing' | 'connected' | 'failed';
}
export interface TelephonyProvider {
  readonly mock: boolean;
  placeMaskedCall(input: {
    callerNumber: string;
    calleeNumber: string;
    virtualNumber: string;
    callbackUrl?: string;
  }): Promise<MaskedCallHandle>;
  endCall(providerRef: string): Promise<void>;
}

// ── Realtime chat + video (Stream) ────────────────────────────────────────────
export interface StreamUserUpsert {
  id: string;
  name?: string;
  image?: string;
}
export interface StreamProvider {
  readonly configured: boolean;
  chatToken(userId: string): string;
  videoToken(userId: string): string;
  upsertUser(user: StreamUserUpsert): Promise<void>;
  verifyWebhook(rawBody: Buffer | string, signature: string): boolean;
}

// ── Push + realtime DB (Firebase) ─────────────────────────────────────────────
export interface PushProvider {
  readonly configured: boolean;
  sendData(token: string, data: Record<string, string>): Promise<void>;
  sendNotification(
    token: string,
    notification: { title: string; body: string },
    data?: Record<string, string>,
    channelId?: string,
  ): Promise<void>;
  rtdbSet(path: string, value: unknown): Promise<void>;
}

// ── Payments (Razorpay) + payouts (RazorpayX) ─────────────────────────────────
export interface PaymentOrder {
  orderId: string;
  amountPaise: number;
}
export interface PaymentsProvider {
  readonly configured: boolean;
  createOrder(input: { amountPaise: number; receipt: string; notes?: Record<string, string> }): Promise<PaymentOrder>;
  verifyPaymentSignature(input: { orderId: string; paymentId: string; signature: string }): boolean;
  verifyWebhook(rawBody: Buffer | string, signature: string): boolean;
}
export interface PayoutHandle {
  payoutRef: string;
  status: 'requested' | 'processing' | 'paid' | 'failed';
}
export interface PayoutsProvider {
  readonly configured: boolean;
  createPayout(input: { amountPaise: number; upiId?: string; fundAccountRef?: string; idempotencyKey: string }): Promise<PayoutHandle>;
}

// ── Object storage (S3) ───────────────────────────────────────────────────────
export interface PresignedUpload {
  uploadUrl: string;
  key: string;
  publicUrl: string;
}
export interface StorageProvider {
  readonly configured: boolean;
  presignUpload(input: { key: string; contentType: string; maxBytes?: number }): Promise<PresignedUpload>;
  publicUrl(key: string): string;
  delete(key: string): Promise<void>;
}
