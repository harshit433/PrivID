import { query, queryOne } from '@trustroute/shared';

/** Derive an immutable verified handle slug from a legal business name. */
export function slugifyVerifiedHandle(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug.length >= 3 ? slug : `biz-${Date.now().toString(36)}`;
}

export async function ensureUniqueVerifiedHandle(base: string): Promise<string> {
  let candidate = base;
  let n = 0;
  while (n < 20) {
    const taken = await queryOne<{ business_id: string }>(
      `SELECT business_id FROM businesses WHERE verified_handle = $1`,
      [candidate],
    );
    if (!taken) return candidate;
    n += 1;
    candidate = `${base}-${n}`;
  }
  return `${base}-${Math.random().toString(36).slice(2, 6)}`;
}
