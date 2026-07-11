import { query, queryOne } from '@trustroute/shared';
import { blockContact } from './blockedContacts';

export type ReportReasonType =
  | 'spam_scam'
  | 'harassment'
  | 'impersonation'
  | 'inappropriate'
  | 'other';

export type ReportContextType =
  | 'call'
  | 'chat'
  | 'contact'
  | 'profile'
  | 'number'
  | 'business';

export interface SubmitUserReportInput {
  reporterId: string;
  reportedUserId?: string | null;
  reportedNumberE164?: string | null;
  reasonType: ReportReasonType;
  note?: string | null;
  contextType?: ReportContextType | null;
  contextId?: string | null;
  blockAlso?: boolean;
}

/** Reporter credibility (0.5–1.5) + corroboration bonus (anti-brigading). */
export async function computeReportWeight(
  reporterId: string,
  target: { userId?: string | null; numberE164?: string | null },
): Promise<number> {
  const reporter = await queryOne<{ trust_score: number }>(
    `SELECT trust_score FROM users WHERE user_id = $1`,
    [reporterId],
  );
  const score = reporter?.trust_score ?? 50;
  const credibility = 0.5 + Math.min(1, score / 100);

  let corroboration = 0;
  if (target.userId) {
    const [row] = await query<{ n: string }>(
      `SELECT COUNT(DISTINCT reporter_id)::text AS n
         FROM user_reports
        WHERE reported_user_id = $1
          AND created_at > NOW() - INTERVAL '7 days'`,
      [target.userId],
    );
    corroboration = Math.min(0.6, parseInt(row?.n ?? '0', 10) * 0.15);
  } else if (target.numberE164) {
    const [row] = await query<{ n: string }>(
      `SELECT COUNT(DISTINCT reporter_id)::text AS n
         FROM user_reports
        WHERE reported_number_e164 = $1
          AND created_at > NOW() - INTERVAL '7 days'`,
      [target.numberE164],
    );
    corroboration = Math.min(0.6, parseInt(row?.n ?? '0', 10) * 0.15);
  }

  return Math.round(Math.min(2, credibility + corroboration) * 100) / 100;
}

export async function submitUserReport(input: SubmitUserReportInput): Promise<{
  report_id: string;
  signal_weight: number;
}> {
  const weight = await computeReportWeight(input.reporterId, {
    userId: input.reportedUserId,
    numberE164: input.reportedNumberE164,
  });

  const [row] = await query<{ report_id: string; signal_weight: string }>(
    `INSERT INTO user_reports (
       reporter_id, reported_user_id, reported_number_e164,
       reason_type, note, context_type, context_id, signal_weight, block_also
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING report_id, signal_weight::text`,
    [
      input.reporterId,
      input.reportedUserId ?? null,
      input.reportedNumberE164 ?? null,
      input.reasonType,
      input.note?.trim() || null,
      input.contextType ?? null,
      input.contextId ?? null,
      weight,
      !!input.blockAlso,
    ],
  );

  if (input.blockAlso && input.reportedUserId) {
    await blockContact(input.reporterId, input.reportedUserId);
  }

  return {
    report_id: row!.report_id,
    signal_weight: parseFloat(row!.signal_weight),
  };
}
