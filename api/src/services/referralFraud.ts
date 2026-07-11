import { query, queryOne } from '@trustroute/shared';
import { getReferralMaxPerDay, getReferralMaxPerWeek } from './referralConfig';

export type FraudCheckResult = { pass: true } | { pass: false; reason: string; code: string };

async function getPrimaryDeviceFingerprint(userId: string): Promise<string | null> {
  const row = await queryOne<{ fp: string }>(
    `SELECT device_fingerprint AS fp FROM device_registrations
     WHERE user_id = $1 AND device_fingerprint IS NOT NULL
     ORDER BY created_at ASC LIMIT 1`,
    [userId],
  );
  return row?.fp ?? null;
}

async function getFaceOrDocRef(userId: string): Promise<string | null> {
  const row = await queryOne<{ ref: string | null }>(
    `SELECT COALESCE(i.face_ref, u.kyc_doc_hash) AS ref
     FROM users u
     LEFT JOIN identities i ON i.identity_id = u.identity_id
     WHERE u.user_id = $1`,
    [userId],
  );
  return row?.ref ?? null;
}

export async function checkReferralFraud(
  referrerId: string,
  referredId: string,
): Promise<FraudCheckResult> {
  if (referrerId === referredId) {
    return { pass: false, reason: 'Self-referral is not allowed.', code: 'SELF_REFERRAL' };
  }

  const [refFp, referredFp, refBio, referredBio] = await Promise.all([
    getPrimaryDeviceFingerprint(referrerId),
    getPrimaryDeviceFingerprint(referredId),
    getFaceOrDocRef(referrerId),
    getFaceOrDocRef(referredId),
  ]);

  if (refFp && referredFp && refFp === referredFp) {
    return { pass: false, reason: 'This invite did not qualify.', code: 'DEVICE_DUP' };
  }

  if (refBio && referredBio && refBio === referredBio) {
    return { pass: false, reason: 'This invite did not qualify.', code: 'BIOMETRIC_DUP' };
  }

  const trust = await queryOne<{ trust_score: number; account_status: string }>(
    `SELECT trust_score, account_status FROM users WHERE user_id = $1`,
    [referredId],
  );
  if (trust && (trust.trust_score < 20 || trust.account_status === 'under_review')) {
    return { pass: false, reason: 'This invite did not qualify.', code: 'LOW_TRUST' };
  }

  const [dayCount, weekCount] = await Promise.all([
    queryOne<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM referrals
       WHERE referrer_id = $1 AND created_at > NOW() - INTERVAL '1 day'`,
      [referrerId],
    ),
    queryOne<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM referrals
       WHERE referrer_id = $1 AND created_at > NOW() - INTERVAL '7 days'`,
      [referrerId],
    ),
  ]);

  const maxDay = await getReferralMaxPerDay();
  const maxWeek = await getReferralMaxPerWeek();
  if (parseInt(dayCount?.c ?? '0', 10) > maxDay) {
    return { pass: false, reason: 'Referral limit reached. Try again later.', code: 'VELOCITY_DAY' };
  }
  if (parseInt(weekCount?.c ?? '0', 10) > maxWeek) {
    return { pass: false, reason: 'Referral limit reached. Try again later.', code: 'VELOCITY_WEEK' };
  }

  const botLike = await queryOne<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM calls
     WHERE (caller_id = $1 OR callee_id = $1)
       AND status = 'ended'
       AND duration_seconds IS NOT NULL
       AND duration_seconds < 3
       AND created_at > NOW() - INTERVAL '7 days'`,
    [referredId],
  );
  const shortCalls = parseInt(botLike?.c ?? '0', 10);
  const totalCalls = await queryOne<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM calls
     WHERE (caller_id = $1 OR callee_id = $1) AND status = 'ended'
       AND created_at > NOW() - INTERVAL '7 days'`,
    [referredId],
  );
  const total = parseInt(totalCalls?.c ?? '0', 10);
  if (total >= 5 && shortCalls / total > 0.8) {
    return { pass: false, reason: 'This invite did not qualify.', code: 'BOT_PATTERN' };
  }

  return { pass: true };
}
