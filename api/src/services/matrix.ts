/**
 * Matrix (Synapse) bridge for TrustRoute messaging.
 *
 * - Mints Synapse JWT login tokens (HS256, claim `sub` = localpart)
 * - Ensures Matrix users exist via Admin API (when admin token is set) or
 *   relies on JWT auto-create on first login
 * - Creates gated DM / group rooms via Client-Server API as the acting user
 */
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { query, queryOne, withTransaction } from '@trustroute/shared';
import { AppError } from '../middleware/errorHandler';
import { gateForSender, orderedPair } from './stream';
import { logger } from '../utils/logger';

const SERVER_NAME = () => process.env.MATRIX_SERVER_NAME ?? 'trustroute.local';
const HS_URL = () => (process.env.MATRIX_HOMESERVER_URL ?? 'http://localhost:8008').replace(/\/$/, '');
const PUBLIC_HS_URL = () =>
  (process.env.MATRIX_PUBLIC_HOMESERVER_URL ?? process.env.MATRIX_HOMESERVER_URL ?? 'http://localhost:8008').replace(/\/$/, '');
const JWT_SECRET = () => process.env.MATRIX_JWT_SECRET ?? 'dev_matrix_jwt_secret_change_me';
const ADMIN_TOKEN = () => process.env.MATRIX_ADMIN_TOKEN ?? '';
const REG_SHARED_SECRET = () => process.env.MATRIX_REGISTRATION_SHARED_SECRET ?? '';
const ROOM_ENCRYPTION = () =>
  (process.env.MATRIX_ROOM_ENCRYPTION ?? 'false').toLowerCase() === 'true';

export function isMatrixConfigured(): boolean {
  return Boolean(process.env.MATRIX_HOMESERVER_URL && process.env.MATRIX_JWT_SECRET);
}

export function matrixLocalpart(userId: string): string {
  return `u${userId.replace(/-/g, '').toLowerCase()}`;
}

export function matrixMxid(userId: string): string {
  return `@${matrixLocalpart(userId)}:${SERVER_NAME()}`;
}

type MatrixUserRow = { user_id: string; mxid: string; localpart: string };

async function getMappedUser(userId: string): Promise<MatrixUserRow | null> {
  return queryOne<MatrixUserRow>(
    `SELECT user_id, mxid, localpart FROM matrix_users WHERE user_id = $1`,
    [userId],
  );
}

async function upsertMapping(userId: string): Promise<MatrixUserRow> {
  const localpart = matrixLocalpart(userId);
  const mxid = matrixMxid(userId);
  await query(
    `INSERT INTO matrix_users (user_id, mxid, localpart)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET mxid = EXCLUDED.mxid, localpart = EXCLUDED.localpart`,
    [userId, mxid, localpart],
  );
  return { user_id: userId, mxid, localpart };
}

async function synapseFetch(
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; data: any }> {
  const url = `${HS_URL()}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(url, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let data: any = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

/** Ensure Synapse user exists (Admin API or registration shared secret). */
async function ensureSynapseUser(userId: string, displayName?: string | null): Promise<MatrixUserRow> {
  const mapped = await upsertMapping(userId);
  const admin = ADMIN_TOKEN();
  if (admin) {
    const encoded = encodeURIComponent(mapped.mxid);
    const get = await synapseFetch(`/_synapse/admin/v2/users/${encoded}`, { token: admin });
    if (get.status === 200) {
      if (displayName) {
        await synapseFetch(`/_synapse/admin/v2/users/${encoded}`, {
          method: 'PUT',
          token: admin,
          body: { displayname: displayName },
        });
      }
      return mapped;
    }

    const password = crypto.randomBytes(24).toString('base64url');
    const created = await synapseFetch(`/_synapse/admin/v2/users/${encoded}`, {
      method: 'PUT',
      token: admin,
      body: {
        password,
        displayname: displayName ?? mapped.localpart,
        admin: false,
        deactivated: false,
      },
    });
    if (created.status >= 400 && created.status !== 409) {
      logger.warn('matrix', `ensureSynapseUser admin failed ${created.status}: ${JSON.stringify(created.data)}`);
    }
    return mapped;
  }

  const shared = REG_SHARED_SECRET();
  if (shared) {
    await ensureUserViaSharedSecret(mapped.localpart, displayName ?? mapped.localpart, shared);
  }
  return mapped;
}

/** Synapse shared-secret user registration (works without admin access token). */
async function ensureUserViaSharedSecret(localpart: string, displayName: string, sharedSecret: string) {
  const nonceRes = await synapseFetch('/_synapse/admin/v1/register');
  const nonce = nonceRes.data?.nonce as string | undefined;
  if (!nonce || nonceRes.status >= 400) {
    logger.warn('matrix', `register nonce failed: ${JSON.stringify(nonceRes.data)}`);
    return;
  }
  const password = crypto.randomBytes(24).toString('base64url');
  const adminFlag = 'notadmin';
  const mac = crypto
    .createHmac('sha1', sharedSecret)
    .update(`${nonce}\0${localpart}\0${password}\0${adminFlag}`)
    .digest('hex');
  const created = await synapseFetch('/_synapse/admin/v1/register', {
    method: 'POST',
    body: {
      nonce,
      username: localpart,
      password,
      displayname: displayName,
      admin: false,
      mac,
    },
  });
  // 400 User ID already taken is fine
  if (created.status >= 400 && created.data?.errcode !== 'M_USER_IN_USE') {
    const msg = JSON.stringify(created.data);
    if (!msg.includes('User ID already taken') && !msg.includes('already exists')) {
      logger.warn('matrix', `shared-secret register failed ${created.status}: ${msg}`);
    }
  }
}

export function mintMatrixLoginJwt(userId: string): string {
  const localpart = matrixLocalpart(userId);
  return jwt.sign(
    { sub: localpart },
    JWT_SECRET(),
    { algorithm: 'HS256', expiresIn: '1h' },
  );
}

/** Exchange JWT for a Matrix access token via CS login. */
export async function loginWithJwt(userId: string): Promise<{
  access_token: string;
  user_id: string;
  device_id: string;
  homeserver_url: string;
}> {
  await ensureSynapseUser(userId);
  const token = mintMatrixLoginJwt(userId);
  const res = await synapseFetch('/_matrix/client/v3/login', {
    method: 'POST',
    body: {
      type: 'org.matrix.login.jwt',
      token,
    },
  });
  if (res.status >= 400 || !res.data?.access_token) {
    throw new AppError(
      502,
      'MATRIX_LOGIN_FAILED',
      res.data?.error ?? 'Could not log in to Matrix homeserver.',
    );
  }
  return {
    access_token: res.data.access_token as string,
    user_id: res.data.user_id as string,
    device_id: res.data.device_id as string,
    homeserver_url: PUBLIC_HS_URL(),
  };
}

export async function getMatrixTokenPayload(userId: string, displayName?: string | null) {
  await ensureSynapseUser(userId, displayName);
  const mapped = await getMappedUser(userId);
  if (!mapped) throw new AppError(500, 'MATRIX_MAP_MISSING', 'Matrix user mapping missing.');

  // Prefer issuing a short-lived access token for the client so it doesn't
  // need to know the JWT secret.
  try {
    const session = await loginWithJwt(userId);
    return {
      homeserver_url: session.homeserver_url,
      server_name: SERVER_NAME(),
      user_id: session.user_id,
      access_token: session.access_token,
      device_id: session.device_id,
      mxid: mapped.mxid,
      localpart: mapped.localpart,
      // Also return login JWT for clients that prefer CS login themselves.
      login_token: mintMatrixLoginJwt(userId),
    };
  } catch (e) {
    // Homeserver might be down during local dev — still return JWT for client-side login.
    logger.warn('matrix', `loginWithJwt failed, returning JWT only: ${String(e)}`);
    return {
      homeserver_url: PUBLIC_HS_URL(),
      server_name: SERVER_NAME(),
      user_id: mapped.mxid,
      access_token: null as string | null,
      device_id: null as string | null,
      mxid: mapped.mxid,
      localpart: mapped.localpart,
      login_token: mintMatrixLoginJwt(userId),
    };
  }
}

function dmKey(a: string, b: string): string {
  const [low, high] = orderedPair(a, b);
  return `${low}:${high}`;
}

async function createRoomAsUser(
  accessToken: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await synapseFetch('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: accessToken,
    body,
  });
  if (res.status >= 400 || !res.data?.room_id) {
    throw new AppError(
      502,
      'MATRIX_CREATE_ROOM_FAILED',
      res.data?.error ?? 'Could not create Matrix room.',
    );
  }
  return res.data.room_id as string;
}

export async function getOrCreateDmRoom(
  myUserId: string,
  otherUserId: string,
): Promise<{ room_id: string; other_user_id: string; created: boolean }> {
  if (myUserId === otherUserId) {
    throw new AppError(400, 'INVALID_PEER', 'Cannot open a DM with yourself.');
  }

  const gate = await gateForSender(myUserId, otherUserId);
  // Allow opening a conversation even when intro-capped — send path re-checks.
  if (gate.mode === 'blocked') {
    throw new AppError(403, gate.code ?? 'CHAT_BLOCKED', gate.reason ?? 'Cannot message this user.');
  }

  const key = dmKey(myUserId, otherUserId);
  const existing = await queryOne<{ room_id: string }>(
    `SELECT room_id FROM matrix_rooms WHERE dm_key = $1`,
    [key],
  );
  if (existing) {
    return { room_id: existing.room_id, other_user_id: otherUserId, created: false };
  }

  const [meLite, otherLite] = await Promise.all([
    queryOne<{ display_name: string | null; handle: string }>(
      `SELECT display_name, handle FROM users WHERE user_id = $1`,
      [myUserId],
    ),
    queryOne<{ display_name: string | null; handle: string }>(
      `SELECT display_name, handle FROM users WHERE user_id = $1`,
      [otherUserId],
    ),
  ]);
  if (!otherLite) throw new AppError(404, 'USER_NOT_FOUND', 'Peer not found.');

  await ensureSynapseUser(myUserId, meLite?.display_name ?? meLite?.handle);
  await ensureSynapseUser(otherUserId, otherLite.display_name ?? otherLite.handle);

  const session = await loginWithJwt(myUserId);
  const otherMxid = matrixMxid(otherUserId);

  const encrypt = ROOM_ENCRYPTION();
  const roomId = await createRoomAsUser(session.access_token, {
    preset: 'trusted_private_chat',
    is_direct: true,
    invite: [otherMxid],
    initial_state: [
      ...(encrypt
        ? [{
            type: 'm.room.encryption',
            state_key: '',
            content: { algorithm: 'm.megolm.v1.aes-sha2' },
          }]
        : []),
      {
        type: 'm.room.guest_access',
        state_key: '',
        content: { guest_access: 'forbidden' },
      },
    ],
    power_level_content_override: {
      users: {
        [session.user_id]: 100,
        [otherMxid]: 100,
      },
    },
    creation_content: { 'm.federate': false },
  });

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO matrix_rooms (room_id, type, dm_key, created_by, encryption)
       VALUES ($1, 'dm', $2, $3, $4)
       ON CONFLICT (dm_key) DO NOTHING`,
      [roomId, key, myUserId, encrypt],
    );
    await client.query(
      `INSERT INTO matrix_room_members (room_id, user_id, role)
       VALUES ($1, $2, 'member'), ($1, $3, 'member')
       ON CONFLICT DO NOTHING`,
      [roomId, myUserId, otherUserId],
    );
  });

  // Peer may need to join (invite). If they already exist, accept invite as them.
  try {
    const peerSession = await loginWithJwt(otherUserId);
    await synapseFetch(`/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
      method: 'POST',
      token: peerSession.access_token,
      body: {},
    });
  } catch (e) {
    logger.warn('matrix', `peer auto-join failed (invite pending): ${String(e)}`);
  }

  return { room_id: roomId, other_user_id: otherUserId, created: true };
}

export async function createGroupRoom(params: {
  creatorId: string;
  groupId: string;
  name: string;
  memberIds: string[];
  avatarUrl?: string | null;
}): Promise<{ room_id: string }> {
  const { creatorId, groupId, name, memberIds, avatarUrl } = params;
  const existing = await queryOne<{ room_id: string }>(
    `SELECT room_id FROM matrix_rooms WHERE group_id = $1`,
    [groupId],
  );
  if (existing) return { room_id: existing.room_id };

  const allMembers = [...new Set([creatorId, ...memberIds])];
  for (const uid of allMembers) {
    const u = await queryOne<{ display_name: string | null; handle: string }>(
      `SELECT display_name, handle FROM users WHERE user_id = $1`,
      [uid],
    );
    await ensureSynapseUser(uid, u?.display_name ?? u?.handle);
  }

  const session = await loginWithJwt(creatorId);
  const invite = allMembers
    .filter((id) => id !== creatorId)
    .map((id) => matrixMxid(id));

  const powerUsers: Record<string, number> = { [session.user_id]: 100 };
  for (const id of allMembers) {
    if (id !== creatorId) powerUsers[matrixMxid(id)] = 50;
  }

  const encrypt = ROOM_ENCRYPTION();
  const roomId = await createRoomAsUser(session.access_token, {
    name,
    preset: 'private_chat',
    invite,
    initial_state: [
      ...(encrypt
        ? [{
            type: 'm.room.encryption',
            state_key: '',
            content: { algorithm: 'm.megolm.v1.aes-sha2' },
          }]
        : []),
      ...(avatarUrl
        ? [{ type: 'm.room.avatar', state_key: '', content: { url: avatarUrl } }]
        : []),
    ],
    power_level_content_override: {
      users: powerUsers,
      invite: 50,
      kick: 50,
      ban: 50,
      redact: 50,
    },
    creation_content: { 'm.federate': false },
  });

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO matrix_rooms (room_id, type, group_id, created_by, title, avatar_url, encryption)
       VALUES ($1, 'group', $2, $3, $4, $5, $6)
       ON CONFLICT (group_id) DO NOTHING`,
      [roomId, groupId, creatorId, name, avatarUrl ?? null, encrypt],
    );
    for (const uid of allMembers) {
      await client.query(
        `INSERT INTO matrix_room_members (room_id, user_id, role)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [roomId, uid, uid === creatorId ? 'admin' : 'member'],
      );
    }
  });

  for (const uid of allMembers) {
    if (uid === creatorId) continue;
    try {
      const peer = await loginWithJwt(uid);
      await synapseFetch(`/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
        method: 'POST',
        token: peer.access_token,
        body: {},
      });
    } catch { /* invite pending */ }
  }

  return { room_id: roomId };
}

export async function getRoomForGroup(groupId: string): Promise<string | null> {
  const row = await queryOne<{ room_id: string }>(
    `SELECT room_id FROM matrix_rooms WHERE group_id = $1`,
    [groupId],
  );
  return row?.room_id ?? null;
}

export async function getDmRoomBetween(a: string, b: string): Promise<string | null> {
  const row = await queryOne<{ room_id: string }>(
    `SELECT room_id FROM matrix_rooms WHERE dm_key = $1`,
    [dmKey(a, b)],
  );
  return row?.room_id ?? null;
}

export async function listMatrixMemberships(userId: string): Promise<
  Array<{ room_id: string; type: string; title: string | null; dm_peer: string | null; group_id: string | null }>
> {
  return query(
    `SELECT r.room_id, r.type, r.title, r.group_id,
            CASE WHEN r.type = 'dm' THEN (
              SELECT m2.user_id::text FROM matrix_room_members m2
              WHERE m2.room_id = r.room_id AND m2.user_id <> $1 LIMIT 1
            ) ELSE NULL END AS dm_peer
     FROM matrix_room_members m
     JOIN matrix_rooms r ON r.room_id = m.room_id
     WHERE m.user_id = $1
     ORDER BY r.updated_at DESC NULLS LAST`,
    [userId],
  );
}
