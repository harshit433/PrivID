import crypto from 'crypto';
import { query, queryOne } from '@trustroute/shared';
import { AppError } from '../middleware/errorHandler';

const MAX_ACTIVE_DISPOSABLE = 5;
const SCHEME = 'trustroute';
const WEB_BASE = process.env.WEB_BASE_URL ?? 'https://trustroute.live';

export type ShareRow = {
  share_id: string;
  owner_id: string;
  token: string;
  type: 'permanent' | 'disposable';
  label: string | null;
  expires_at: Date | null;
  max_uses: number | null;
  uses: number;
  active: boolean;
  receive_only: boolean;
  created_at: Date;
};

export type ShareEventRow = {
  event_id: string;
  share_id: string;
  scanner_id: string | null;
  device_hash: string | null;
  created_at: Date;
  scanner_handle?: string | null;
  scanner_name?: string | null;
};

function newToken(): string {
  return crypto.randomBytes(18).toString('base64url');
}

function deeplink(token: string, type: 'permanent' | 'disposable', handle?: string): string {
  if (type === 'permanent' && handle) {
    return `${SCHEME}://u/${encodeURIComponent(handle)}`;
  }
  return `${SCHEME}://s/${token}`;
}

function universalLink(token: string, type: 'permanent' | 'disposable', handle?: string): string {
  if (type === 'permanent' && handle) {
    return `${WEB_BASE}/u/${encodeURIComponent(handle)}`;
  }
  return `${WEB_BASE}/s/${token}`;
}

function isExpired(row: ShareRow): boolean {
  if (!row.active) return true;
  if (row.expires_at && new Date(row.expires_at) <= new Date()) return true;
  if (row.max_uses != null && row.uses >= row.max_uses) return true;
  return false;
}

export async function getPermanentQrPayload(userId: string): Promise<{
  handle: string;
  deeplink: string;
  universal_link: string;
  display_name: string | null;
  avatar_url: string | null;
}> {
  const user = await queryOne<{ handle: string; display_name: string | null; avatar_url: string | null }>(
    `SELECT handle, display_name, avatar_url FROM users WHERE user_id = $1`,
    [userId],
  );
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
  return {
    handle: user.handle,
    deeplink: deeplink('', 'permanent', user.handle),
    universal_link: universalLink('', 'permanent', user.handle),
    display_name: user.display_name,
    avatar_url: user.avatar_url,
  };
}

export async function createDisposableShare(
  userId: string,
  params: { label?: string; expires_at?: string; max_uses?: number | null },
): Promise<{
  share_id: string;
  token: string;
  deeplink: string;
  universal_link: string;
  label: string | null;
  expires_at: string | null;
  max_uses: number | null;
}> {
  const activeCount = await queryOne<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM contact_shares
     WHERE owner_id = $1 AND type = 'disposable' AND active = TRUE
       AND (expires_at IS NULL OR expires_at > NOW())
       AND (max_uses IS NULL OR uses < max_uses)`,
    [userId],
  );
  if (parseInt(activeCount?.cnt ?? '0', 10) >= MAX_ACTIVE_DISPOSABLE) {
    throw new AppError(
      409,
      'SHARE_LIMIT',
      `You can have up to ${MAX_ACTIVE_DISPOSABLE} active one-time handles. Revoke one to create another.`,
    );
  }

  const token = newToken();
  const [row] = await query<ShareRow>(
    `INSERT INTO contact_shares (owner_id, token, type, label, expires_at, max_uses, receive_only)
     VALUES ($1, $2, 'disposable', $3, $4, $5, TRUE)
     RETURNING *`,
    [
      userId,
      token,
      params.label?.trim() || null,
      params.expires_at ? new Date(params.expires_at) : null,
      params.max_uses ?? null,
    ],
  );

  return {
    share_id: row!.share_id,
    token: row!.token,
    deeplink: deeplink(row!.token, 'disposable'),
    universal_link: universalLink(row!.token, 'disposable'),
    label: row!.label,
    expires_at: row!.expires_at ? new Date(row!.expires_at).toISOString() : null,
    max_uses: row!.max_uses,
  };
}

export async function listShares(userId: string): Promise<Array<{
  share_id: string;
  label: string | null;
  token: string;
  deeplink: string;
  expires_at: string | null;
  max_uses: number | null;
  uses: number;
  active: boolean;
  created_at: string;
  events_count: number;
}>> {
  const rows = await query<ShareRow & { events_count: string }>(
    `SELECT cs.*,
            (SELECT COUNT(*)::text FROM share_events se WHERE se.share_id = cs.share_id) AS events_count
     FROM contact_shares cs
     WHERE cs.owner_id = $1 AND cs.type = 'disposable'
     ORDER BY cs.created_at DESC
     LIMIT 50`,
    [userId],
  );

  return rows.map((r) => ({
    share_id: r.share_id,
    label: r.label,
    token: r.token,
    deeplink: deeplink(r.token, 'disposable'),
    expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    max_uses: r.max_uses,
    uses: r.uses,
    active: r.active && !isExpired(r),
    created_at: new Date(r.created_at).toISOString(),
    events_count: parseInt(r.events_count, 10),
  }));
}

export async function getShareDetail(userId: string, shareId: string): Promise<{
  share: ReturnType<typeof listShares> extends Promise<(infer T)[]> ? T : never;
  events: Array<{
    event_id: string;
    scanner_handle: string | null;
    scanner_name: string | null;
    created_at: string;
  }>;
}> {
  const share = await queryOne<ShareRow>(
    `SELECT * FROM contact_shares WHERE share_id = $1 AND owner_id = $2`,
    [shareId, userId],
  );
  if (!share) throw new AppError(404, 'NOT_FOUND', 'Share not found.');

  const events = await query<ShareEventRow>(
    `SELECT se.event_id, se.scanner_id, se.created_at,
            u.handle AS scanner_handle, u.display_name AS scanner_name
     FROM share_events se
     LEFT JOIN users u ON u.user_id = se.scanner_id
     WHERE se.share_id = $1
     ORDER BY se.created_at DESC
     LIMIT 100`,
    [shareId],
  );

  return {
    share: {
      share_id: share.share_id,
      label: share.label,
      token: share.token,
      deeplink: deeplink(share.token, 'disposable'),
      expires_at: share.expires_at ? new Date(share.expires_at).toISOString() : null,
      max_uses: share.max_uses,
      uses: share.uses,
      active: share.active && !isExpired(share),
      created_at: new Date(share.created_at).toISOString(),
      events_count: events.length,
    },
    events: events.map((e) => ({
      event_id: e.event_id,
      scanner_handle: (e as ShareEventRow).scanner_handle ?? null,
      scanner_name: (e as ShareEventRow).scanner_name ?? null,
      created_at: new Date(e.created_at).toISOString(),
    })),
  };
}

export async function revokeShare(userId: string, shareId: string): Promise<{ revoked: boolean }> {
  const row = await queryOne<{ share_id: string }>(
    `UPDATE contact_shares
     SET active = FALSE, revoked_at = NOW()
     WHERE share_id = $1 AND owner_id = $2 AND active = TRUE
     RETURNING share_id`,
    [shareId, userId],
  );
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Share not found or already revoked.');
  return { revoked: true };
}

export async function resolveShareToken(
  token: string,
  scannerId?: string,
  deviceHash?: string,
): Promise<{
  profile: {
    user_id: string;
    handle: string;
    display_name: string | null;
    avatar_url: string | null;
    trust_tier: string;
    trust_score: number;
  };
  share_type: 'disposable' | 'permanent';
  expires_at: string | null;
  owner_handle: string;
  label: string | null;
  receive_only: boolean;
}> {
  const share = await queryOne<ShareRow>(
    `SELECT * FROM contact_shares WHERE token = $1 AND active = TRUE`,
    [token],
  );
  if (!share || isExpired(share)) {
    throw new AppError(410, 'SHARE_EXPIRED', 'This code has expired or is not valid.');
  }

  // Receive-only: only scanners (people who were given the link) may initiate.
  // The owner cannot "use" their own disposable token to cold-outbound.
  if (share.receive_only !== false && scannerId && scannerId === share.owner_id) {
    throw new AppError(
      403,
      'SHARE_RECEIVE_ONLY',
      'This is a receive-only handle. Share it so others can reach you — you cannot use it to contact yourself.',
    );
  }

  const owner = await queryOne<{
    user_id: string;
    handle: string;
    display_name: string | null;
    avatar_url: string | null;
    trust_tier: string;
    trust_score: number;
    account_status: string;
  }>(
    `SELECT user_id, handle, display_name, avatar_url, trust_tier, trust_score, account_status
     FROM users WHERE user_id = $1`,
    [share.owner_id],
  );
  if (!owner || owner.account_status !== 'active') {
    throw new AppError(410, 'SHARE_EXPIRED', 'This code has expired or is not valid.');
  }

  await query(
    `INSERT INTO share_events (share_id, scanner_id, device_hash) VALUES ($1, $2, $3)`,
    [share.share_id, scannerId ?? null, deviceHash ?? null],
  );
  await query(
    `UPDATE contact_shares SET uses = uses + 1 WHERE share_id = $1`,
    [share.share_id],
  );

  return {
    profile: {
      user_id: owner.user_id,
      handle: owner.handle,
      display_name: owner.display_name,
      avatar_url: owner.avatar_url,
      trust_tier: owner.trust_tier,
      trust_score: owner.trust_score,
    },
    share_type: share.type,
    expires_at: share.expires_at ? new Date(share.expires_at).toISOString() : null,
    owner_handle: owner.handle,
    label: share.label,
    receive_only: share.receive_only !== false,
  };
}

export async function resolveDeepLink(
  url: string,
  scannerId?: string,
  deviceHash?: string,
): Promise<{
  kind: 'user' | 'disposable' | 'business' | 'unknown';
  handle?: string;
  token?: string;
  resolved?: Awaited<ReturnType<typeof resolveShareToken>>;
}> {
  const trimmed = url.trim();
  const userMatch = trimmed.match(/(?:trustroute|privid):\/\/u\/([^?#\s/]+)/i)
    ?? trimmed.match(/trustroute\.(?:app|live)\/u\/([^?#\s/]+)/i);
  if (userMatch) {
    const handle = decodeURIComponent(userMatch[1]).replace(/^@/, '');
    return { kind: 'user', handle };
  }

  const shareMatch = trimmed.match(/(?:trustroute|privid):\/\/s\/([^?#\s/]+)/i)
    ?? trimmed.match(/trustroute\.(?:app|live)\/s\/([^?#\s/]+)/i);
  if (shareMatch) {
    const token = shareMatch[1];
    const resolved = await resolveShareToken(token, scannerId, deviceHash);
    return { kind: 'disposable', token, resolved };
  }

  const bizMatch = trimmed.match(/(?:trustroute|privid):\/\/biz\/([^?#\s/]+)/i);
  if (bizMatch) return { kind: 'business', token: bizMatch[1] };

  return { kind: 'unknown' };
}
