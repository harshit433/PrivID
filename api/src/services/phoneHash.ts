import crypto from 'crypto';

/** Normalize Indian/international numbers to E.164-ish digits for hashing. */
export function normalizePhoneNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (digits.length > 10 && raw.trim().startsWith('+')) return `+${digits}`;
  return `+${digits}`;
}

export function hashPhoneNumber(raw: string): string {
  const e164 = normalizePhoneNumber(raw);
  return crypto.createHash('sha256').update(e164).digest('hex');
}

export function maskPhoneNumber(raw: string): string {
  const e164 = normalizePhoneNumber(raw);
  const digits = e164.replace(/\D/g, '');
  if (digits.length <= 4) return '••••';
  return `••••${digits.slice(-4)}`;
}
