import type { DialerOutcome } from '@trustroute/shared';

/** Maps legacy + v2 outcomes to scoring buckets. */
export function outcomeBucket(outcome: DialerOutcome): 'pick' | 'decline' | 'block' | 'save' | 'hung_fast' | 'neutral' {
  switch (outcome) {
    case 'picked_up':
    case 'incoming_accepted':
    case 'outgoing_answered':
      return 'pick';
    case 'declined':
    case 'incoming_declined':
    case 'outgoing_declined':
    case 'incoming_missed':
    case 'outgoing_missed':
      return 'decline';
    case 'blocked':
    case 'incoming_blocked':
      return 'block';
    case 'saved':
      return 'save';
    case 'hung_up_fast':
      return 'hung_fast';
    default:
      return 'neutral';
  }
}

/**
 * Weight applied before insert — contact/trusted-context events count less
 * toward network shadow reputation (personal context, not spam signal).
 */
export function computeObservationWeight(
  outcome: DialerOutcome,
  isContact: boolean,
  isTrustRouteUser: boolean,
  connectionType?: string | null,
): number {
  let weight = 1;

  const softDecline =
    outcome === 'incoming_missed' ||
    outcome === 'incoming_declined' ||
    outcome === 'outgoing_missed' ||
    outcome === 'outgoing_declined' ||
    outcome === 'declined';

  if (softDecline && isContact) weight *= 0.25;
  if (softDecline && isTrustRouteUser && connectionType === 'trusted') weight *= 0.1;
  if (softDecline && isTrustRouteUser && connectionType === 'blocked') weight = 0;

  if (outcome === 'incoming_accepted' || outcome === 'outgoing_answered' || outcome === 'picked_up') {
    if (isTrustRouteUser && connectionType === 'trusted') weight *= 1.1;
  }

  return Math.max(0, Math.min(1, Math.round(weight * 1000) / 1000));
}

export function scoreToLabel(score: number, observationCount: number): string {
  if (observationCount < 5) return 'UNKNOWN';
  if (score <= 25) return 'SPAM';
  if (score <= 40) return 'SUSPICIOUS';
  if (score <= 59) return 'UNKNOWN';
  if (score <= 79) return 'NEUTRAL';
  return 'TRUSTED';
}

export function scoreToRingColor(score: number, observationCount: number, source: 'trustroute' | 'shadow'): string {
  if (source === 'trustroute') {
    if (score >= 75) return '#22C55E';
    if (score >= 55) return '#EAB308';
    if (score >= 35) return '#F97316';
    return '#EF4444';
  }
  const label = scoreToLabel(score, observationCount);
  if (label === 'TRUSTED') return '#22C55E';
  if (label === 'NEUTRAL') return '#EAB308';
  if (label === 'SUSPICIOUS') return '#F97316';
  if (label === 'SPAM') return '#EF4444';
  return '#9CA3AF';
}
