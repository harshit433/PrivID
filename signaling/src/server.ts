/**
 * PrivID Signaling Server
 *
 * Handles WebRTC negotiation between caller and callee.
 *
 * Protocol:
 *   Client connects: ws://host:3001?token=<JWT>&room=<webrtc_room_id>
 *
 * Message types (client → server):
 *   { type: 'offer',         sdp: string }
 *   { type: 'answer',        sdp: string }
 *   { type: 'ice-candidate', candidate: RTCIceCandidateInit }
 *   { type: 'ping' }
 *   { type: 'call-status',   status: 'ringing' | 'answered' | 'declined' | 'ended' }
 *
 * Message types (server → client):
 *   { type: 'offer',         sdp: string, from: userId }
 *   { type: 'answer',        sdp: string, from: userId }
 *   { type: 'ice-candidate', candidate: RTCIceCandidateInit, from: userId }
 *   { type: 'pong' }
 *   { type: 'peer-joined',   userId: string }
 *   { type: 'peer-left',     userId: string }
 *   { type: 'call-status',   status: string, from: userId }
 *   { type: 'error',         code: string, message: string }
 */

import 'dotenv/config';
import path from 'path';
import fs from 'fs';

const envPath = path.resolve(__dirname, '../../api/.env');
if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath });

import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import jwt from 'jsonwebtoken';
import type { AccessTokenPayload } from '@privid/shared';
import { queryOne } from '@privid/shared';

const PORT = parseInt(process.env.SIGNALING_PORT ?? '3001', 10);

// ─── Types ────────────────────────────────────────────────────────────────────

interface SignalingClient {
  ws: WebSocket;
  userId: string;
  handle: string;
  roomId: string;
}

type SignalingMessage =
  | { type: 'offer';         sdp: string }
  | { type: 'answer';        sdp: string }
  | { type: 'ice-candidate'; candidate: object }
  | { type: 'ping' }
  | { type: 'call-status';   status: string };

// ─── State ────────────────────────────────────────────────────────────────────

// roomId → set of clients in that room (max 2 for a call)
const rooms = new Map<string, Set<SignalingClient>>();
// userId → client (for push lookups)
const userSockets = new Map<string, SignalingClient>();
// Last SDP offer per room (replay when callee connects slightly after caller sends offer)
const lastOfferByRoom = new Map<string, { sdp: string; from: string }>();
const lastAnswerByRoom = new Map<string, { sdp: string; from: string }>();
const candidateCacheByRoom = new Map<string, Array<{ candidate: object; from: string }>>();
const roomCleanupTimers = new Map<string, NodeJS.Timeout>();
const ROOM_CACHE_TTL_MS = 2 * 60 * 1000;

// ─── JWT verification ─────────────────────────────────────────────────────────

/** api/ directory — .env paths like ./keys/public.pem are relative to this, not signaling cwd. */
const API_DIR = path.resolve(__dirname, '../../api');

let _publicKey: string | null = null;
function getPublicKey(): string {
  if (!_publicKey) {
    const configured = process.env.JWT_PUBLIC_KEY_PATH ?? 'keys/public.pem';
    const keyPath = path.isAbsolute(configured)
      ? configured
      : path.join(API_DIR, configured.replace(/^\.\//, ''));
    _publicKey = fs.readFileSync(keyPath, 'utf8');
  }
  return _publicKey;
}

function verifyToken(token: string): AccessTokenPayload | null {
  try {
    return jwt.verify(token, getPublicKey(), { algorithms: ['RS256'] }) as AccessTokenPayload;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[signaling] JWT verify failed:', msg);
    return null;
  }
}

function extractToken(req: IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  return url.searchParams.get('token');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function send(client: SignalingClient, msg: object) {
  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(msg));
  }
}

function broadcast(roomId: string, msg: object, exclude?: SignalingClient) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const client of room) {
    if (client !== exclude) send(client, msg);
  }
}

function addToRoom(roomId: string, client: SignalingClient) {
  const cleanupTimer = roomCleanupTimers.get(roomId);
  if (cleanupTimer) {
    clearTimeout(cleanupTimer);
    roomCleanupTimers.delete(roomId);
  }
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  rooms.get(roomId)!.add(client);
}

function removeFromRoom(client: SignalingClient, opts?: { notifyPeers?: boolean }) {
  const notifyPeers = opts?.notifyPeers !== false;
  const room = rooms.get(client.roomId);
  if (!room) return;
  room.delete(client);
  if (room.size === 0) {
    rooms.delete(client.roomId);
    scheduleRoomCacheCleanup(client.roomId);
  } else if (notifyPeers) {
    broadcast(client.roomId, { type: 'peer-left', userId: client.userId });
  }
}

function scheduleRoomCacheCleanup(roomId: string) {
  if (roomCleanupTimers.has(roomId)) return;
  const timer = setTimeout(() => {
    roomCleanupTimers.delete(roomId);
    lastOfferByRoom.delete(roomId);
    lastAnswerByRoom.delete(roomId);
    candidateCacheByRoom.delete(roomId);
  }, ROOM_CACHE_TTL_MS);
  roomCleanupTimers.set(roomId, timer);
}

function cacheCandidate(roomId: string, candidate: object, from: string) {
  const items = candidateCacheByRoom.get(roomId) ?? [];
  items.push({ candidate, from });
  if (items.length > 80) items.splice(0, items.length - 80);
  candidateCacheByRoom.set(roomId, items);
}

function replayCachedSignaling(client: SignalingClient) {
  const cachedOffer = lastOfferByRoom.get(client.roomId);
  if (cachedOffer && cachedOffer.from !== client.userId) {
    send(client, { type: 'offer', sdp: cachedOffer.sdp, from: cachedOffer.from });
  }

  const cachedAnswer = lastAnswerByRoom.get(client.roomId);
  if (cachedAnswer && cachedAnswer.from !== client.userId) {
    send(client, { type: 'answer', sdp: cachedAnswer.sdp, from: cachedAnswer.from });
  }

  const cachedCandidates = candidateCacheByRoom.get(client.roomId) ?? [];
  for (const item of cachedCandidates) {
    if (item.from !== client.userId) {
      send(client, { type: 'ice-candidate', candidate: item.candidate, from: item.from });
    }
  }
}

/** Drop a stale socket for the same user without telling peers they left (React dev remounts). */
function replaceUserSocket(existing: SignalingClient) {
  removeFromRoom(existing, { notifyPeers: false });
  try {
    existing.ws.close(4002, 'replaced');
  } catch {
    /* already closed */
  }
}

// ─── Server ───────────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: PORT });

async function handleConnection(ws: WebSocket, req: IncomingMessage) {
  const url = new URL(req.url ?? '/', `ws://localhost:${PORT}`);
  const token = extractToken(req, url);
  const roomParam = url.searchParams.get('room');

  if (!token || !roomParam) {
    ws.close(4001, 'Missing token or room');
    return;
  }

  const payload = verifyToken(token);
  if (!payload) {
    ws.close(4003, 'Invalid or expired token');
    return;
  }

  // Match webrtc_room_id (normal) or call_id (legacy clients that passed callId as room)
  const call = await queryOne<{
    call_id: string;
    caller_id: string;
    callee_id: string;
    status: string;
    webrtc_room_id: string;
  }>(
    `SELECT call_id, caller_id, callee_id, status, webrtc_room_id
     FROM calls
     WHERE webrtc_room_id = $1 OR call_id::text = $1
     LIMIT 1`,
    [roomParam],
  );

  if (!call) {
    console.warn(`[signaling] rejected: room not found for param=${roomParam.slice(0, 12)}…`);
    ws.close(4004, 'Room not found');
    return;
  }

  const roomId = call.webrtc_room_id;

  if (call.caller_id !== payload.sub && call.callee_id !== payload.sub) {
    console.warn(`[signaling] rejected: ${payload.handle} not in call ${call.call_id}`);
    ws.close(4003, 'Not a participant of this call');
    return;
  }

  if (!['initiated', 'ringing', 'answered'].includes(call.status)) {
    console.warn(`[signaling] rejected: call ${call.call_id} status=${call.status}`);
    ws.close(4010, 'Call is not active');
    return;
  }

  const client: SignalingClient = {
    ws,
    userId: payload.sub,
    handle: payload.handle,
    roomId,
  };

  const existing = userSockets.get(payload.sub);
  if (existing) {
    replaceUserSocket(existing);
  }

  addToRoom(roomId, client);
  userSockets.set(payload.sub, client);

  console.log(`[signaling] ${payload.handle} joined room ${roomId} (call ${call.call_id}, status=${call.status})`);
  send(client, { type: 'ready' });

  const room = rooms.get(roomId)!;
  for (const peer of room) {
    if (peer === client) continue;
    send(client, { type: 'peer-joined', userId: peer.userId, handle: peer.handle });
  }
  if (room.size > 1) {
    broadcast(roomId, { type: 'peer-joined', userId: payload.sub, handle: payload.handle }, client);
  }

  replayCachedSignaling(client);

  ws.on('message', (data: Buffer) => {
    let msg: SignalingMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      send(client, { type: 'error', code: 'BAD_MESSAGE', message: 'Invalid JSON' });
      return;
    }

    switch (msg.type) {
      case 'ping':
        send(client, { type: 'pong' });
        break;

      case 'offer':
        lastOfferByRoom.set(roomId, { sdp: msg.sdp, from: client.userId });
        console.log(`[signaling] offer ${client.handle} -> room ${roomId}`);
        broadcast(roomId, { ...msg, from: client.userId }, client);
        break;

      case 'answer':
        lastAnswerByRoom.set(roomId, { sdp: msg.sdp, from: client.userId });
        console.log(`[signaling] answer ${client.handle} -> room ${roomId}`);
        broadcast(roomId, { ...msg, from: client.userId }, client);
        break;

      case 'ice-candidate':
        cacheCandidate(roomId, msg.candidate, client.userId);
        broadcast(roomId, { ...msg, from: client.userId }, client);
        break;

      case 'call-status':
        broadcast(roomId, { ...msg, from: client.userId }, client);
        break;

      default:
        send(client, { type: 'error', code: 'UNKNOWN_TYPE', message: 'Unknown message type' });
    }
  });

  // ─── Disconnect handler ──────────────────────────────────────────────────

  ws.on('close', () => {
    if (userSockets.get(client.userId) !== client) return;
    console.log(`[signaling] ${client.handle} left room ${roomId}`);
    removeFromRoom(client);
    userSockets.delete(client.userId);
  });

  ws.on('error', (err) => {
    console.error(`[signaling] Error for ${client.handle}:`, err.message);
    if (userSockets.get(client.userId) !== client) return;
    removeFromRoom(client);
    userSockets.delete(client.userId);
  });
}

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  void handleConnection(ws, req).catch((err) => {
    console.error('[signaling] connection handler failed:', err);
    try {
      ws.close(1011, 'Internal error');
    } catch {
      /* already closed */
    }
  });
});

wss.on('listening', () => {
  console.log(`[signaling] WebSocket server running on ws://localhost:${PORT}`);
});

// ─── Stats endpoint helper ────────────────────────────────────────────────────

export function getRoomStats() {
  return {
    activeRooms: rooms.size,
    connectedClients: userSockets.size,
    rooms: Array.from(rooms.entries()).map(([roomId, clients]) => ({
      roomId,
      participants: Array.from(clients).map((c) => c.handle),
    })),
  };
}
