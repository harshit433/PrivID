/**
 * Marketing-site form captures (contact + waitlist). Write-only from the public site;
 * read/export happens in admin tooling.
 */
import { db, websiteContactMessages, websiteWaitlistSignups } from '@trustroute/core';

export async function insertContact(input: {
  name: string;
  email: string;
  message: string;
  source?: string | null;
  page?: string | null;
  userAgent?: string | null;
  ipHash?: string | null;
}): Promise<string> {
  const [row] = await db.insert(websiteContactMessages).values(input).returning({ id: websiteContactMessages.id });
  return row!.id;
}

export async function insertWaitlist(input: {
  name: string;
  email: string;
  interestLevel: number;
  whyBetter: string;
  whyWilling: string;
  source?: string | null;
  page?: string | null;
  userAgent?: string | null;
  ipHash?: string | null;
}): Promise<string> {
  const [row] = await db.insert(websiteWaitlistSignups).values(input).returning({ id: websiteWaitlistSignups.id });
  return row!.id;
}
