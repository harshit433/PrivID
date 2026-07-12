import type { OnboardingSessionRow } from '@trustroute/shared';

/** Client-facing next screen after DigiLocker / liveness / match. */
export type OnboardingNextStep =
  | 'digilocker'
  | 'liveness'
  | 'match'
  | 'handle'
  | 'profile_photo'
  | 'recovery_complete'
  | 'already_have_account'
  | 'welcome_back'
  | 'blocked'
  | 'suspended'
  | 'done'
  | 'expired';

/**
 * Exact resume target from durable session state.
 * DigiLocker verified → liveness (not digilocker again).
 * After liveness, identity/account branch is resolved in the same step (no face match).
 */
export function computeNextStep(session: OnboardingSessionRow): OnboardingNextStep {
  if (session.status === 'expired' || new Date(session.expires_at) < new Date()) {
    return 'expired';
  }
  if (session.status === 'completed') {
    return 'done';
  }

  switch (session.status) {
    case 'started':
    case 'device_checked':
    case 'digilocker_started':
      return 'digilocker';

    case 'digilocker_verified':
    case 'liveness_started':
      return 'liveness';

    // Legacy: sessions left at liveness_verified before dedup was folded into liveness.
    // Resume runs a quick account-branch finalize (no face compare), then handle/recovery.
    case 'liveness_verified':
      return 'match';

    case 'matched': {
      return nextStepAfterMatched(session);
    }

    default:
      return 'digilocker';
  }
}

function nextStepAfterMatched(session: OnboardingSessionRow): OnboardingNextStep {
  if (session.branch === 'banned' || session.branch === 'ousted') return 'blocked';
  if (session.branch === 'suspended') return 'suspended';
  if (session.branch === 'self_deleted') return 'welcome_back';
  if (session.branch === 'active') {
    if (session.purpose === 'recovery' || session.purpose === 'pin_reset') {
      return 'recovery_complete';
    }
    return 'already_have_account';
  }
  if (session.selected_handle) return 'profile_photo';
  return 'handle';
}

/** Statuses that may start / re-open DigiLocker. */
export function canStartDigilocker(status: string): boolean {
  return status === 'started' || status === 'device_checked' || status === 'digilocker_started';
}

/** Statuses that may run liveness. */
export function canStartLiveness(status: string): boolean {
  return status === 'digilocker_verified' || status === 'liveness_started';
}

/** Statuses that may complete liveness (submit selfie). */
export function canCompleteLiveness(status: string): boolean {
  return status === 'liveness_started' || status === 'liveness_verified';
}
