/**
 * Handle candidate generation and legal-name matching for onboarding.
 * Ported from backend/api utils + handle validation.
 */
import { appError } from '@trustroute/core';
import type { OnboardingSession } from './onboarding.repository';
import * as repo from './onboarding.repository';

export function normalizeHandle(input: string): string {
  return input.trim().toLowerCase().replace(/^@/, '');
}

function cleanToken(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function handleMatchesLegalName(handle: string, legalName: string): boolean {
  const h = cleanToken(handle);
  const tokens = legalName
    .split(/\s+/)
    .map(cleanToken)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return true;
  return tokens.some((token) => h.includes(token));
}

/** Build handle candidates from a display name (lowercase, underscores, 3–30 chars). */
export function buildHandleCandidates(name: string): string[] {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);

  if (words.length === 0) return [];

  const first = words[0]!;
  const last = words.length > 1 ? words[words.length - 1]! : '';
  const full = words.join('_').slice(0, 24);
  const rand = () => String(Math.floor(1000 + Math.random() * 9000));

  const raw = [
    full,
    last ? `${first}_${last}` : first,
    `${first}_${rand()}`,
    last ? `${first}${last[0]}_${rand()}` : `${first}_${rand()}`,
    `${first}${last}`.slice(0, 24),
    `${first}_${last.slice(0, 4)}_${rand()}`.replace(/_+/g, '_'),
  ];

  return [
    ...new Set(
      raw
        .map((h) =>
          h
            .replace(/[^a-z0-9_]/g, '')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, ''),
        )
        .filter((h) => h.length >= 3 && h.length <= 30),
    ),
  ];
}

export async function validateHandleForSession(
  session: OnboardingSession,
  rawHandle: string,
): Promise<string> {
  const handle = normalizeHandle(rawHandle);
  if (!/^[a-z0-9._]{3,30}$/.test(handle)) {
    throw appError('HANDLE_INVALID');
  }
  if (!session.legalName) {
    throw appError('ONBOARDING_STATE_INVALID', 'Verify your identity before choosing a handle.');
  }
  if (!handleMatchesLegalName(handle, session.legalName)) {
    throw appError(
      'HANDLE_INVALID',
      `Your handle should be based on your verified name, ${session.legalName}.`,
    );
  }
  if (await repo.handleTaken(handle)) {
    throw appError('HANDLE_TAKEN', `@${handle} is taken. Try another.`);
  }
  return handle;
}
