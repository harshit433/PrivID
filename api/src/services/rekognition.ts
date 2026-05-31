import {
  RekognitionClient,
  CreateFaceLivenessSessionCommand,
  GetFaceLivenessSessionResultsCommand,
} from '@aws-sdk/client-rekognition';

// ─── Configuration ──────────────────────────────────────────────────────────────
// Amazon Rekognition Face Liveness needs:
//   • Server-side AWS credentials (reuse the S3 ones) able to call
//     CreateFaceLivenessSession / GetFaceLivenessSessionResults.
//   • A Cognito Identity Pool (unauth role allowed rekognition:StartFaceLivenessSession)
//     so the client component can stream the selfie video directly to Rekognition.
//   • A Face Liveness-supported region (e.g. us-east-1).

export function livenessRegion(): string {
  return (process.env.LIVENESS_REGION || process.env.AWS_REGION || 'us-east-1').trim();
}

export function livenessIdentityPoolId(): string | undefined {
  const id = process.env.LIVENESS_IDENTITY_POOL_ID?.trim();
  return id ? id : undefined;
}

export function livenessThreshold(): number {
  const n = Number(process.env.LIVENESS_CONFIDENCE_THRESHOLD);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : 80;
}

/**
 * Fully configured only when we have server credentials AND a Cognito identity
 * pool for the client to stream with. Without these the flow falls back to a
 * dev bypass (auto-pass) so local development works without an AWS account.
 */
export function isLivenessConfigured(): boolean {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY &&
    (process.env.LIVENESS_REGION || process.env.AWS_REGION) &&
    livenessIdentityPoolId(),
  );
}

let _client: RekognitionClient | null = null;
function getClient(): RekognitionClient {
  if (_client) return _client;
  _client = new RekognitionClient({
    region: livenessRegion(),
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
  return _client;
}

/** Create a Face Liveness session. Returns the Rekognition SessionId (a UUID). */
export async function createLivenessSession(): Promise<string> {
  const out = await getClient().send(
    new CreateFaceLivenessSessionCommand({
      Settings: { AuditImagesLimit: 1 },
    }),
  );
  if (!out.SessionId) {
    throw Object.assign(new Error('Rekognition did not return a SessionId.'), {
      code: 'LIVENESS_SESSION_FAILED',
    });
  }
  return out.SessionId;
}

export interface LivenessResult {
  status: string;      // CREATED | IN_PROGRESS | SUCCEEDED | FAILED | EXPIRED
  confidence: number;  // 0–100
}

/** Fetch the analysed results for a completed Face Liveness session. */
export async function getLivenessResults(sessionId: string): Promise<LivenessResult> {
  const out = await getClient().send(
    new GetFaceLivenessSessionResultsCommand({ SessionId: sessionId }),
  );
  return {
    status: out.Status ?? 'UNKNOWN',
    confidence: typeof out.Confidence === 'number' ? out.Confidence : 0,
  };
}
