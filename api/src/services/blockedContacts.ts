import { query, queryOne } from '@trustroute/shared';
import { AppError } from '../middleware/errorHandler';
import { syncConnectionToStream } from './stream';

export interface BlockedContact {
  user_id: string;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
  connection_id: string;
  blocked_at: string;
}

export async function listBlockedContacts(ownerId: string): Promise<BlockedContact[]> {
  const rows = await query<{
    connection_id: string;
    contact_id: string;
    created_at: Date;
    handle: string;
    display_name: string | null;
    avatar_url: string | null;
  }>(
    `SELECT c.connection_id, c.contact_id, c.created_at,
            u.handle, u.display_name, u.avatar_url
       FROM connections c
       JOIN users u ON u.user_id = c.contact_id
      WHERE c.owner_id = $1 AND c.connection_type = 'blocked'
      ORDER BY c.created_at DESC`,
    [ownerId],
  );

  return rows.map((r) => ({
    user_id: r.contact_id,
    handle: r.handle,
    display_name: r.display_name,
    avatar_url: r.avatar_url,
    connection_id: r.connection_id,
    blocked_at: r.created_at.toISOString(),
  }));
}

export async function blockContact(ownerId: string, contactId: string): Promise<void> {
  const existing = await queryOne<{ connection_id: string }>(
    `SELECT connection_id FROM connections WHERE owner_id = $1 AND contact_id = $2`,
    [ownerId, contactId],
  );
  if (existing) {
    await query(
      `UPDATE connections SET connection_type = 'blocked', updated_at = NOW()
        WHERE connection_id = $1`,
      [existing.connection_id],
    );
  } else {
    await query(
      `INSERT INTO connections (owner_id, contact_id, connection_type)
       VALUES ($1, $2, 'blocked')`,
      [ownerId, contactId],
    );
  }
  await syncConnectionToStream(ownerId, contactId, 'blocked').catch(() => {});
}

export async function unblockContact(ownerId: string, contactId: string): Promise<void> {
  const conn = await queryOne<{ connection_id: string }>(
    `SELECT connection_id FROM connections
      WHERE owner_id = $1 AND contact_id = $2 AND connection_type = 'blocked'`,
    [ownerId, contactId],
  );
  if (!conn) {
    throw new AppError(404, 'NOT_BLOCKED', 'This contact is not blocked.');
  }

  await query(
    `UPDATE connections SET connection_type = 'unknown', updated_at = NOW()
      WHERE connection_id = $1`,
    [conn.connection_id],
  );

  await syncConnectionToStream(ownerId, contactId, 'unknown').catch(() => {});
}
