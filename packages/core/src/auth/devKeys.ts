/**
 * Dev/test JWT key bootstrap. When no signing keys are configured and we're not in
 * production, generate an RS256 keypair and persist it under ./keys (gitignored) so
 * tokens survive restarts. Production always requires real keys via env/PEM — this
 * never runs there.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../logger';

export function ensureDevKeys(): void {
  if (config.isProd) return;
  if (config.JWT_PUBLIC_KEY_B64 && config.JWT_PRIVATE_KEY_B64) return;

  const pubPath = path.resolve(config.JWT_PUBLIC_KEY_PATH);
  const privPath = path.resolve(config.JWT_PRIVATE_KEY_PATH);
  if (fs.existsSync(pubPath) && fs.existsSync(privPath)) return;

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  fs.mkdirSync(path.dirname(pubPath), { recursive: true });
  fs.writeFileSync(pubPath, publicKey);
  fs.writeFileSync(privPath, privateKey);
  logger.warn('auth', 'generated ephemeral dev RS256 keypair', { pubPath, privPath });
}
