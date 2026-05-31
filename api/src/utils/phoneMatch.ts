/** Normalize to digits-only for comparison (keeps country code when present). */
export function phoneDigits(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * Compare two phone values — matches on full E.164 or last 10 national digits.
 */
export function phonesMatch(a: string, b: string): boolean {
  const da = phoneDigits(a);
  const db = phoneDigits(b);
  if (!da || !db) return false;
  if (da === db) return true;
  if (da.length >= 10 && db.length >= 10) {
    return da.slice(-10) === db.slice(-10);
  }
  return false;
}
