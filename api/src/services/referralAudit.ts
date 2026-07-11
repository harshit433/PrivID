import { query } from '@trustroute/shared';

export async function logReferralAudit(params: {
  referralId?: string;
  userId?: string;
  action: string;
  fromStatus?: string;
  toStatus?: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  await query(
    `INSERT INTO referral_audit_events (referral_id, user_id, action, from_status, to_status, meta)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      params.referralId ?? null,
      params.userId ?? null,
      params.action,
      params.fromStatus ?? null,
      params.toStatus ?? null,
      JSON.stringify(params.meta ?? {}),
    ],
  );
}
