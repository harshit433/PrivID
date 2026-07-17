/**
 * Onboarding service: the signup / recovery state machine.
 *
 *   start → device_checked → digilocker_started → digilocker_verified
 *         → liveness_started → liveness_verified → completed
 *
 * DigiLocker (KYC) and liveness run behind provider abstractions, so the whole flow
 * is exercisable end-to-end against mocks. Completion mints an identity + user and
 * issues a session; the ephemeral face images are purged at that point.
 */
import crypto from 'crypto';
import {
  appError,
  config,
  getKycProvider,
  getLivenessProvider,
  logger,
} from '@trustroute/core';
import * as repo from './onboarding.repository';
import type { OnboardingSession } from './onboarding.repository';
import { classify } from '../identity/identity.service';
import type { IdentityBranch } from '../identity/identity.service';
import * as usersRepo from '../users/users.repository';
import { issueSession, publicUser } from '../auth/auth.service';

/** Branches that may advance past KYC, keyed by session purpose. */
const PROCEEDABLE: Record<string, Set<IdentityBranch>> = {
  signup: new Set<IdentityBranch>(['new', 'self_deleted']),
  recovery: new Set<IdentityBranch>(['active', 'self_deleted']),
  pin_reset: new Set<IdentityBranch>(['active']),
};

/** Load a session, rejecting an unknown id or an expired one. */
async function loadActive(sessionId: string): Promise<OnboardingSession> {
  const s = await repo.findById(sessionId);
  if (!s) throw appError('ONBOARDING_STATE_INVALID', 'No such verification session.');
  if (s.status === 'completed') throw appError('ONBOARDING_STATE_INVALID', 'This session is already complete.');
  if (s.expiresAt && s.expiresAt.getTime() < Date.now()) throw appError('ONBOARDING_EXPIRED');
  return s;
}

function expect(s: OnboardingSession, allowed: string[]): void {
  if (!allowed.includes(s.status)) {
    throw appError('ONBOARDING_STATE_INVALID', `Expected step ${allowed.join('/')}, but session is at ${s.status}.`);
  }
}

/**
 * Stable identity anchor from the KYC document. The masked Aadhaar + normalized legal
 * name + DOB is deterministic for a given person, so re-verifying maps to the same
 * `doc_hash` (and thus the same identity row) across sessions.
 */
function computeDocHash(id: { maskedAadhaar: string; legalName: string; dob?: string }): string {
  const norm = id.legalName.trim().toLowerCase().replace(/\s+/g, ' ');
  return crypto
    .createHash('sha256')
    .update(`${id.maskedAadhaar}|${norm}|${id.dob ?? ''}`)
    .digest('hex');
}

function blockedError(branch: IdentityBranch) {
  switch (branch) {
    case 'suspended':
      return appError('ACCOUNT_SUSPENDED');
    case 'banned':
    case 'ousted':
      return appError('ACCOUNT_BANNED');
    case 'active':
      return appError('IDENTITY_ALREADY_CLAIMED', 'This identity already has an account. Please sign in instead.');
    case 'new':
      return appError('ONBOARDING_STATE_INVALID', 'No existing account was found to recover.');
    default:
      return appError('ONBOARDING_STATE_INVALID');
  }
}

function view(s: OnboardingSession) {
  return {
    sessionId: s.sessionId,
    purpose: s.purpose,
    status: s.status,
    branch: s.branch,
    legalName: s.legalName,
    selectedHandle: s.selectedHandle,
    expiresAt: s.expiresAt,
  };
}

// ── Steps ─────────────────────────────────────────────────────────────────────

export async function start(input: {
  purpose?: string;
  deviceFingerprintHash?: string;
  integrity?: Record<string, unknown>;
}) {
  const s = await repo.create({
    purpose: input.purpose ?? 'signup',
    deviceFingerprintHash: input.deviceFingerprintHash ?? null,
    integrityVerdict: input.integrity,
    status: 'device_checked',
  });
  logger.debug('onboarding', 'session started', { sessionId: s.sessionId, purpose: s.purpose });
  return view(s);
}

export async function digilockerStart(sessionId: string) {
  const s = await loadActive(sessionId);
  expect(s, ['device_checked', 'digilocker_started']);
  const kyc = getKycProvider();
  const redirectUrl = `${config.API_BASE_URL ?? 'http://localhost:3000'}/onboarding/digilocker/return`;
  const { requestId, authUrl } = await kyc.createRequest(redirectUrl);
  await repo.patch(sessionId, { status: 'digilocker_started', digilockerProviderRef: requestId });
  return { authUrl, providerRef: requestId, mock: kyc.mock };
}

export async function digilockerCallback(sessionId: string) {
  const s = await loadActive(sessionId);
  expect(s, ['digilocker_started', 'digilocker_verified']);
  const requestId = s.digilockerProviderRef;
  if (!requestId) throw appError('ONBOARDING_STATE_INVALID', 'DigiLocker was not started for this session.');

  const kyc = getKycProvider();
  const status = await kyc.getStatus(requestId);
  if (status.status === 'pending') throw appError('KYC_FAILED', 'Identity verification is still pending.');
  if (status.status !== 'verified') throw appError('KYC_FAILED');

  const identityDoc = await kyc.fetchIdentity(requestId);
  const docHash = computeDocHash(identityDoc);
  const { branch, identity } = await classify(docHash);

  const updated = await repo.patch(sessionId, {
    status: 'digilocker_verified',
    legalName: identityDoc.legalName,
    docType: 'aadhaar',
    docHash,
    identityId: identity?.identityId ?? null,
    matchedUserId: identity?.currentUserId ?? null,
    branch,
    docPhotoB64: identityDoc.photoBase64 ?? null,
  });

  const canProceed = (PROCEEDABLE[s.purpose] ?? PROCEEDABLE.signup!).has(branch);
  return { ...view(updated), branch, canProceed };
}

export async function livenessStart(sessionId: string) {
  const s = await loadActive(sessionId);
  expect(s, ['digilocker_verified', 'liveness_started']);
  const liveness = getLivenessProvider();
  await repo.patch(sessionId, { status: 'liveness_started', livenessProviderRef: `live_${crypto.randomBytes(6).toString('hex')}` });
  return { available: liveness.available(), mock: liveness.mock };
}

export async function livenessComplete(sessionId: string, selfieB64: string, docPhotoB64?: string) {
  const s = await loadActive(sessionId);
  expect(s, ['liveness_started', 'digilocker_verified']);
  const liveness = getLivenessProvider();

  const live = await liveness.check(selfieB64);
  if (!live.pass) throw appError('LIVENESS_FAILED');

  const reference = docPhotoB64 ?? s.docPhotoB64;
  if (reference) {
    const match = await liveness.compareFaces(reference, selfieB64);
    if (!match.match) throw appError('LIVENESS_FAILED', 'Your selfie did not match your ID photo.');
  }

  const updated = await repo.patch(sessionId, {
    status: 'liveness_verified',
    selfieB64: null, // don't retain the raw selfie past the check
  });
  return { ...view(updated), livenessScore: live.score };
}

export async function checkHandle(handle: string) {
  const taken = await repo.handleTaken(handle);
  return { handle: handle.toLowerCase(), available: !taken };
}

export async function setHandle(sessionId: string, handle: string, displayName?: string) {
  const s = await loadActive(sessionId);
  expect(s, ['liveness_verified', 'digilocker_verified']);
  if (await repo.handleTaken(handle)) throw appError('HANDLE_TAKEN');
  const updated = await repo.patch(sessionId, {
    selectedHandle: handle.toLowerCase(),
    pendingDisplayName: displayName ?? null,
  });
  return { ...view(updated), available: true };
}

export async function complete(sessionId: string, pin?: string) {
  const s = await loadActive(sessionId);
  expect(s, ['liveness_verified']);

  const branch = (s.branch ?? 'new') as IdentityBranch;
  const proceedable = (PROCEEDABLE[s.purpose] ?? PROCEEDABLE.signup!).has(branch);
  if (!proceedable) throw blockedError(branch);

  if (!s.docHash || !s.legalName) throw appError('ONBOARDING_STATE_INVALID', 'Identity verification is incomplete.');

  const pinHash = pin ? await usersRepo.hashPin(pin) : null;

  // Recovery / pin-reset onto an existing active account: re-key the session, don't
  // create a new user (the identity already points at one).
  if (branch === 'active' && s.matchedUserId) {
    const user = await usersRepo.findById(s.matchedUserId);
    if (!user) throw appError('USER_INACTIVE');
    if (pinHash) await usersRepo.setPin(user.userId, pinHash);
    const session = await issueSession(user);
    await repo.markCompleted(sessionId);
    const fresh = pin ? await usersRepo.findById(user.userId) : user;
    return { ...session, user: publicUser(fresh ?? user) };
  }

  // Signup (new) or recreate (self_deleted): a handle must have been reserved.
  if (!s.selectedHandle) throw appError('ONBOARDING_STATE_INVALID', 'Please choose a handle first.');
  if (await repo.handleTaken(s.selectedHandle)) throw appError('HANDLE_TAKEN');

  const { user } = await repo.createAccount({
    existingIdentityId: branch === 'self_deleted' ? s.identityId : null,
    legalName: s.legalName,
    docType: s.docType ?? 'aadhaar',
    docHash: s.docHash,
    provider: 'setu',
    providerRef: s.digilockerProviderRef,
    handle: s.selectedHandle,
    displayName: s.pendingDisplayName ?? null,
    pinHash,
  });

  const session = await issueSession(user);
  await repo.markCompleted(sessionId);
  logger.info('onboarding', 'account created', { userId: user.userId, handle: user.handle, branch });
  return { ...session, user: publicUser(user) };
}
