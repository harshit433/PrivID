/**
 * JWT (RS256) access tokens + opaque refresh tokens.
 *
 * Access tokens are short-lived RS256 JWTs verified with the public key. Refresh
 * tokens are opaque random strings stored only as SHA-256 hashes server-side.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export type TrustTier = 'anonymous' | 'basic' | 'verified' | 'premium';

export interface AccessTokenPayload {
  sub: string; // user UUID
  handle: string;
  tier: TrustTier;
  iat: number;
  exp: number;
  iss?: string;
}

let publicKey: string | null = null;
let privateKey: string | null = null;

function loadKey(b64: string | undefined, filePath: string): string {
  if (b64) return Buffer.from(b64, 'base64').toString('utf8');
  return fs.readFileSync(path.resolve(filePath), 'utf8');
}

export function getPublicKey(): string {
  if (!publicKey) publicKey = loadKey(config.JWT_PUBLIC_KEY_B64, config.JWT_PUBLIC_KEY_PATH);
  return publicKey;
}

export function getPrivateKey(): string {
  if (!privateKey) privateKey = loadKey(config.JWT_PRIVATE_KEY_B64, config.JWT_PRIVATE_KEY_PATH);
  return privateKey;
}

export function signAccessToken(input: { sub: string; handle: string; tier: TrustTier }): string {
  return jwt.sign({ handle: input.handle, tier: input.tier }, getPrivateKey(), {
    algorithm: 'RS256',
    subject: input.sub,
    issuer: config.JWT_ISSUER,
    expiresIn: config.JWT_ACCESS_TTL_SECONDS,
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, getPublicKey(), {
    algorithms: ['RS256'],
    issuer: config.JWT_ISSUER,
  }) as AccessTokenPayload;
}

/** Generate an opaque refresh token and its storage hash. Persist only the hash. */
export function generateRefreshToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(48).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export { jwt };
