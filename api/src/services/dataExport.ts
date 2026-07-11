import crypto from 'crypto';
import { query, queryOne } from '@trustroute/shared';
import { AppError } from '../middleware/errorHandler';
import { scheduleDataExport } from './dataExportQueue';

async function getExportSlaHours(): Promise<number> {
  const row = await queryOne<{ value: unknown }>(
    `SELECT value FROM feature_flags WHERE key = 'data_export_sla_hours'`,
  );
  const n = parseInt(String(row?.value ?? '72').replace(/"/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 72;
}

export async function requestDataExport(userId: string): Promise<{
  request_id: string;
  status: string;
  email: string | null;
  eta_hours: number;
}> {
  const user = await queryOne<{ email: string | null; is_active: boolean }>(
    `SELECT email, is_active FROM users WHERE user_id = $1`,
    [userId],
  );
  if (!user?.is_active) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');

  const recent = await queryOne<{ request_id: string }>(
    `SELECT request_id FROM data_export_requests
      WHERE user_id = $1 AND status IN ('requested', 'processing')
        AND created_at > NOW() - INTERVAL '24 hours'
      ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  if (recent) {
    throw new AppError(409, 'EXPORT_IN_PROGRESS', 'You already have a data export in progress.');
  }

  const row = await queryOne<{ request_id: string }>(
    `INSERT INTO data_export_requests (user_id, email, status)
     VALUES ($1, $2, 'requested')
     RETURNING request_id`,
    [userId, user.email],
  );
  const requestId = row!.request_id;
  scheduleDataExport(requestId, userId);

  const etaHours = await getExportSlaHours();
  return {
    request_id: requestId,
    status: 'requested',
    email: user.email,
    eta_hours: etaHours,
  };
}

export async function runDataExport(requestId: string): Promise<void> {
  const req = await queryOne<{ request_id: string; user_id: string; status: string }>(
    `SELECT request_id, user_id, status FROM data_export_requests WHERE request_id = $1`,
    [requestId],
  );
  if (!req || req.status === 'ready') return;

  await query(`UPDATE data_export_requests SET status = 'processing' WHERE request_id = $1`, [requestId]);

  try {
    const user = await queryOne(`SELECT * FROM users WHERE user_id = $1`, [req.user_id]);
    const connections = await query(`SELECT * FROM connections WHERE owner_id = $1`, [req.user_id]);
    const calls = await query(
      `SELECT call_id, status, created_at FROM calls
        WHERE caller_id = $1 OR callee_id = $1 ORDER BY created_at DESC LIMIT 500`,
      [req.user_id],
    );
    const trustFactors = await query(`SELECT factor_type, status, verified_at FROM trust_factors WHERE user_id = $1`, [
      req.user_id,
    ]);

    const exportPayload = {
      exported_at: new Date().toISOString(),
      user: user
        ? {
            user_id: user.user_id,
            handle: user.handle,
            display_name: user.display_name,
            email: user.email,
            profession: user.profession,
            organisation: user.organisation,
            bio: user.bio,
            address: user.address,
            created_at: user.created_at,
          }
        : null,
      connections_count: connections.length,
      connections: connections.map((c: Record<string, unknown>) => ({
        connection_type: c.connection_type,
        contact_id: c.contact_id,
        created_at: c.created_at,
      })),
      recent_calls_count: calls.length,
      trust_factors: trustFactors,
    };

    const token = crypto.randomBytes(24).toString('hex');
    const downloadUrl = `${process.env.API_BASE_URL ?? 'https://api.trustroute.app'}/me/export/${token}`;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await query(
      `UPDATE data_export_requests
          SET status = 'ready',
              download_url = $2,
              expires_at = $3,
              completed_at = NOW()
        WHERE request_id = $1`,
      [requestId, downloadUrl, expiresAt],
    );

    // Email delivery would be wired here in production (SES/SendGrid).
  } catch {
    await query(`UPDATE data_export_requests SET status = 'failed', completed_at = NOW() WHERE request_id = $1`, [
      requestId,
    ]);
    throw new Error('Data export failed');
  }
}
