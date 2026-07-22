/**
 * Auth service: @handle + 6-digit PIN sign-in, refresh-token rotation, logout.
 * Identity verification (KYC) happens in onboarding; here we mint sessions for
 * accounts that already exist. One active refresh token per user (single session).
 */
import bcrypt from 'bcryptjs';
import {
  signAccessToken,
  generateRefreshToken,
  hashToken,
  config,
  appError,
  assertCanAuthenticate,
} from '@trustroute/core';
import * as usersRepo from '../users/users.repository';
import type { UserRow } from '../users/users.repository';
import * as authRepo from './auth.repository';

export function publicUser(u: UserRow) {
  return {
    userId: u.userId,
    identityId: u.identityId,
    handle: u.handle,
    displayName: u.displayName,
    legalName: u.legalName,
    avatarUrl: u.avatarUrl,
    trustTier: u.trustTier,
    trustScore: u.trustScore,
    onboardingComplete: u.onboardingComplete,
    discoveryMode: u.discoveryMode,
    accountStatus: u.accountStatus,
    phoneVerified: Boolean(u.phoneE164),
    pinSet: Boolean(u.pinHash),
  };
}

/**
 * Mint a fresh session (access + rotating refresh) for an existing user, replacing
 * any prior session. Shared by PIN login, refresh rotation, and onboarding completion.
 */
export async function issueSession(user: UserRow, deviceId?: string | null) {
  const accessToken = signAccessToken({ sub: user.userId, handle: user.handle, tier: user.trustTier });
  const { token: refreshToken, tokenHash } = generateRefreshToken();
  // Single active session: drop previous refresh tokens, then store the new hash.
  await authRepo.revokeAllForUser(user.userId);
  await authRepo.insertRefreshToken({
    userId: user.userId,
    tokenHash,
    expiresAt: new Date(Date.now() + config.JWT_REFRESH_TTL_SECONDS * 1000),
    deviceId,
  });
  return { accessToken, refreshToken };
}

export async function checkHandle(handle: string) {
  const u = await usersRepo.findByHandle(handle);
  if (!u) throw appError('HANDLE_NOT_FOUND');
  return { exists: true, pinSet: Boolean(u.pinHash), handle: u.handle };
}

export async function loginWithPin(handle: string, pin: string, deviceId?: string) {
  const u = await usersRepo.findByHandle(handle);
  if (!u) throw appError('HANDLE_NOT_FOUND');
  assertCanAuthenticate({ accountStatus: u.accountStatus, isActive: u.isActive });
  if (!u.pinHash) throw appError('PIN_NOT_SET');
  if (u.pinLockedUntil && u.pinLockedUntil.getTime() > Date.now()) throw appError('PIN_LOCKED');

  const ok = await bcrypt.compare(pin, u.pinHash);
  if (!ok) {
    const { lockedUntil } = await usersRepo.recordPinFailure(u.userId);
    if (lockedUntil && lockedUntil.getTime() > Date.now()) throw appError('PIN_LOCKED');
    throw appError('PIN_INVALID');
  }
  await usersRepo.clearPinFailures(u.userId);
  const { accessToken, refreshToken } = await issueSession(u, deviceId);
  return { accessToken, refreshToken, user: publicUser(u) };
}

export async function refresh(refreshToken: string) {
  const tokenHash = hashToken(refreshToken);
  const found = await authRepo.findActiveRefreshToken(tokenHash);
  if (!found) throw appError('INVALID_TOKEN', 'Refresh token invalid or expired.');
  const u = await usersRepo.findById(found.userId);
  if (!u) throw appError('USER_INACTIVE');
  assertCanAuthenticate({ accountStatus: u.accountStatus, isActive: u.isActive });
  await authRepo.revokeToken(tokenHash); // rotate
  const { accessToken, refreshToken: newRefresh } = await issueSession(u);
  return { accessToken, refreshToken: newRefresh, user: publicUser(u) };
}

export async function logout(userId: string): Promise<void> {
  await authRepo.revokeAllForUser(userId);
}

export async function setUserPin(userId: string, pin: string): Promise<void> {
  await usersRepo.setPin(userId, await usersRepo.hashPin(pin));
}

export async function changeUserPin(userId: string, currentPin: string, pin: string): Promise<void> {
  const u = await usersRepo.findById(userId);
  if (!u) throw appError('USER_INACTIVE');
  assertCanAuthenticate({ accountStatus: u.accountStatus, isActive: u.isActive });
  if (!u.pinHash) throw appError('PIN_NOT_SET');
  if (u.pinLockedUntil && u.pinLockedUntil.getTime() > Date.now()) throw appError('PIN_LOCKED');

  const ok = await bcrypt.compare(currentPin, u.pinHash);
  if (!ok) {
    const { lockedUntil } = await usersRepo.recordPinFailure(u.userId);
    if (lockedUntil && lockedUntil.getTime() > Date.now()) throw appError('PIN_LOCKED');
    throw appError('PIN_INVALID');
  }
  await usersRepo.clearPinFailures(u.userId);
  await setUserPin(u.userId, pin);
}
