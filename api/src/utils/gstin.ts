/** Indian GSTIN format + optional checksum validation (deterministic, no external API). */
const GSTIN_REGEX =
  /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function gstinChecksumChar(gstin14: string): string {
  let factor = 2;
  let sum = 0;
  const mod = CHARS.length;
  for (let i = 13; i >= 0; i--) {
    const codePoint = CHARS.indexOf(gstin14[i]!);
    let addend = factor * codePoint;
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / mod) + (addend % mod);
    sum += addend;
  }
  const checksum = (mod - (sum % mod)) % mod;
  return CHARS[checksum]!;
}

export function validateGstin(gstin: string): {
  valid: boolean;
  normalized: string;
  reason?: string;
} {
  const normalized = gstin.trim().toUpperCase();
  if (!normalized) {
    return { valid: false, normalized, reason: 'GSTIN is required.' };
  }
  if (normalized.length !== 15) {
    return { valid: false, normalized, reason: 'GSTIN must be 15 characters.' };
  }
  if (!GSTIN_REGEX.test(normalized)) {
    return { valid: false, normalized, reason: 'GSTIN format is invalid.' };
  }
  const expected = gstinChecksumChar(normalized.slice(0, 14));
  if (normalized[14] !== expected) {
    return { valid: false, normalized, reason: 'GSTIN checksum does not match.' };
  }
  return { valid: true, normalized };
}
