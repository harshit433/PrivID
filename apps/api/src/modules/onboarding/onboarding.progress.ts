/**
 * Client-facing next screen from durable onboarding session state.
 */
import type { OnboardingSession } from './onboarding.repository';

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

export function computeNextStep(session: OnboardingSession): OnboardingNextStep {
  if (session.status === 'expired') {
    return 'expired';
  }
  if (session.expiresAt && session.expiresAt.getTime() < Date.now()) {
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

    case 'liveness_verified':
      return nextAfterLiveness(session);

    default:
      return 'digilocker';
  }
}

function nextAfterLiveness(session: OnboardingSession): OnboardingNextStep {
  const branch = session.branch;
  if (branch === 'banned' || branch === 'ousted') return 'blocked';
  if (branch === 'suspended') return 'suspended';
  if (branch === 'self_deleted') return 'welcome_back';
  if (branch === 'active') {
    if (session.purpose === 'recovery' || session.purpose === 'pin_reset') {
      return 'recovery_complete';
    }
    return 'already_have_account';
  }
  if (session.selectedHandle) return 'profile_photo';
  return 'handle';
}
