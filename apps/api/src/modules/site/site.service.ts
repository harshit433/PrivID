/**
 * Site service: accept public contact + waitlist submissions. The submitter's IP is
 * only ever stored as a salted hash (spam/rate context), never in the clear.
 */
import crypto from 'crypto';
import * as repo from './site.repository';

function hashIp(ip?: string): string | null {
  if (!ip) return null;
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 32);
}

export async function contact(
  input: { name: string; email: string; message: string; source?: string; page?: string },
  meta: { ip?: string; userAgent?: string },
) {
  const id = await repo.insertContact({
    name: input.name,
    email: input.email.toLowerCase(),
    message: input.message,
    source: input.source ?? null,
    page: input.page ?? null,
    userAgent: meta.userAgent ?? null,
    ipHash: hashIp(meta.ip),
  });
  return { id, received: true };
}

export async function waitlist(
  input: { name: string; email: string; interestLevel: number; whyBetter: string; whyWilling: string; source?: string; page?: string },
  meta: { ip?: string; userAgent?: string },
) {
  const id = await repo.insertWaitlist({
    name: input.name,
    email: input.email.toLowerCase(),
    interestLevel: input.interestLevel,
    whyBetter: input.whyBetter,
    whyWilling: input.whyWilling,
    source: input.source ?? null,
    page: input.page ?? null,
    userAgent: meta.userAgent ?? null,
    ipHash: hashIp(meta.ip),
  });
  return { id, received: true };
}
