import { query, queryOne, withTransaction } from '@trustroute/shared';
import type { UserRow } from '@trustroute/shared';
import { AppError } from '../middleware/errorHandler';
import { validateHandleForUser } from './handleValidation';

async function getHandleCooldownDays(): Promise<number> {
  const row = await queryOne<{ value: unknown }>(
    `SELECT value FROM feature_flags WHERE key = 'handle_change_cooldown_days'`,
  );
  const n = parseInt(String(row?.value ?? '30').replace(/"/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

export async function getHandleChangeStatus(userId: string): Promise<{
  can_change: boolean;
  next_change_at: string | null;
  cooldown_days: number;
}> {
  const user = await queryOne<{ handle_changed_at: Date | null }>(
    `SELECT handle_changed_at FROM users WHERE user_id = $1`,
    [userId],
  );
  const cooldownDays = await getHandleCooldownDays();
  if (!user?.handle_changed_at) {
    return { can_change: true, next_change_at: null, cooldown_days: cooldownDays };
  }
  const next = new Date(user.handle_changed_at);
  next.setDate(next.getDate() + cooldownDays);
  const canChange = Date.now() >= next.getTime();
  return {
    can_change: canChange,
    next_change_at: canChange ? null : next.toISOString(),
    cooldown_days: cooldownDays,
  };
}

export async function changeUserHandle(userId: string, rawHandle: string): Promise<{
  handle: string;
  propagation_job_id: string;
}> {
  const status = await getHandleChangeStatus(userId);
  if (!status.can_change && status.next_change_at) {
    const date = new Date(status.next_change_at).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    throw new AppError(
      429,
      'HANDLE_COOLDOWN',
      `You can change your handle again on ${date}.`,
      { next_change_at: status.next_change_at },
    );
  }

  const user = await queryOne<UserRow>(
    `SELECT user_id, handle, legal_name, display_name, avatar_url FROM users WHERE user_id = $1 AND is_active = TRUE`,
    [userId],
  );
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');

  const newHandle = await validateHandleForUser(userId, user.legal_name, rawHandle);
  if (newHandle === user.handle) {
    throw new AppError(400, 'NO_CHANGES', 'That is already your handle.');
  }

  let jobId = '';
  await withTransaction(async (client) => {
    const race = await client.query<{ user_id: string }>(
      `SELECT user_id FROM users WHERE handle = $1 AND user_id != $2 FOR UPDATE`,
      [newHandle, userId],
    );
    if (race.rows[0]) {
      throw new AppError(409, 'HANDLE_TAKEN', `@${newHandle} was just taken. Try another.`);
    }

    await client.query(
      `UPDATE users SET handle = $2, handle_changed_at = NOW(), updated_at = NOW() WHERE user_id = $1`,
      [userId, newHandle],
    );

    const job = await client.query<{ job_id: string }>(
      `INSERT INTO handle_propagation_jobs (user_id, old_handle, new_handle)
       VALUES ($1, $2, $3)
       RETURNING job_id`,
      [userId, user.handle, newHandle],
    );
    jobId = job.rows[0].job_id;
  });

  try {
    const { scheduleHandlePropagation } = await import('./handleQueue');
    scheduleHandlePropagation(jobId, userId);
  } catch {
    // Worker cron will pick up pending jobs.
  }

  return { handle: newHandle, propagation_job_id: jobId };
}

export async function runHandlePropagation(jobId: string): Promise<{ connections_updated: number }> {
  const job = await queryOne<{
    job_id: string;
    user_id: string;
    old_handle: string;
    new_handle: string;
    status: string;
  }>(
    `SELECT job_id, user_id, old_handle, new_handle, status FROM handle_propagation_jobs WHERE job_id = $1`,
    [jobId],
  );
  if (!job || job.status === 'done') return { connections_updated: 0 };

  await query(`UPDATE handle_propagation_jobs SET status = 'processing' WHERE job_id = $1`, [jobId]);

  const user = await queryOne<{ display_name: string | null; avatar_url: string | null }>(
    `SELECT display_name, avatar_url FROM users WHERE user_id = $1`,
    [job.user_id],
  );

  let updated = 0;
  try {
    const { upsertStreamUser, isStreamConfigured } = await import('./stream');
    if (isStreamConfigured() && user) {
      await upsertStreamUser({
        user_id: job.user_id,
        handle: job.new_handle,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
      });
    }

    const contacts = await query<{ contact_id: string }>(
      `SELECT DISTINCT contact_id
         FROM connections
        WHERE owner_id = $1
          AND connection_type IN ('trusted', 'temporary')`,
      [job.user_id],
    );
    updated = contacts.length;

    await query(
      `UPDATE handle_propagation_jobs
          SET status = 'done', connections_updated = $2, completed_at = NOW()
        WHERE job_id = $1`,
      [jobId, updated],
    );
  } catch {
    await query(
      `UPDATE handle_propagation_jobs SET status = 'failed', completed_at = NOW() WHERE job_id = $1`,
      [jobId],
    );
    throw new Error('Handle propagation failed');
  }

  return { connections_updated: updated };
}

export async function scanPendingHandlePropagations(): Promise<{ processed: number }> {
  const pending = await query<{ job_id: string }>(
    `SELECT job_id FROM handle_propagation_jobs
      WHERE status IN ('pending', 'failed')
      ORDER BY created_at ASC
      LIMIT 50`,
  );
  let processed = 0;
  for (const row of pending) {
    try {
      await runHandlePropagation(row.job_id);
      processed++;
    } catch {
      // logged by worker
    }
  }
  return { processed };
}
