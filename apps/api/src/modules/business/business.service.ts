/**
 * Business service. Two audiences:
 *   - app users (JWT): discover verified businesses, subscribe, inbox, block/report
 *   - business operators (API key): manage channels, broadcast messages
 * Verification (admin) issues the API key (returned once). Broadcasts fan out to active,
 * non-blocking subscribers synchronously here; the worker can assume this at scale (P8).
 */
import crypto from 'crypto';
import {
  appError,
  buildPage,
  decodeCursor,
  getRedis,
  keys,
  TTL,
  type PageMeta,
} from '@trustroute/core';
import * as repo from './business.repository';
import type { BusinessRow, ChannelRow, MessageRow } from './business.repository';
import * as notifications from '../notifications/notifications.service';

export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function publicBusiness(b: BusinessRow) {
  return {
    businessId: b.businessId,
    name: b.name,
    category: b.category,
    website: b.website,
    logoUrl: b.logoUrl,
    verifiedHandle: b.verifiedHandle,
    status: b.status,
  };
}

function channelView(c: ChannelRow) {
  return { channelId: c.channelId, name: c.name, channelType: c.channelType, dailyLimitPerSubscriber: c.dailyLimitPerSubscriber, active: c.active };
}

// ── Registration + verification (admin issues the key) ───────────────────────

export async function register(input: { name: string; category: string; contactEmail: string; gstin?: string; cin?: string; website?: string }) {
  const b = await repo.createBusiness(input);
  return { businessId: b.businessId, status: b.status };
}

/** Admin-only: verify + mint an API key. The plaintext key is returned exactly once. */
export async function verifyAndIssueKey(businessId: string): Promise<{ business: ReturnType<typeof publicBusiness>; apiKey: string }> {
  const business = await repo.findById(businessId);
  if (!business) throw appError('NOT_FOUND', 'Business not found.');
  const apiKey = `trk_live_${crypto.randomBytes(24).toString('base64url')}`;
  const updated = await repo.setVerified(businessId, hashApiKey(apiKey));
  if (!updated) throw appError('CONFLICT', 'Business is already verified.');
  return { business: publicBusiness(updated), apiKey };
}

export async function reject(businessId: string, reason: string) {
  if (!(await repo.setRejected(businessId, reason))) throw appError('NOT_FOUND', 'Business not found.');
  return { rejected: true };
}

export async function listByStatus(status: BusinessRow['status']) {
  return { businesses: (await repo.listByStatus(status)).map(publicBusiness) };
}

/** Resolve an API key to its business (for the requireBusiness guard). */
export async function authenticateApiKey(apiKey: string): Promise<BusinessRow> {
  const business = await repo.findByApiKeyHash(hashApiKey(apiKey));
  if (!business) throw appError('UNAUTHORIZED', 'Invalid API key.');
  return business;
}

// ── User-facing ───────────────────────────────────────────────────────────────

export async function directory(userId: string) {
  const [list, subs, blocked] = await Promise.all([
    repo.listVerified(100),
    repo.subscribedChannelIds(userId),
    repo.blockedBusinessIds(userId),
  ]);
  const subSet = new Set(subs);
  const blockSet = new Set(blocked);
  const out = [];
  for (const b of list) {
    const channels = await repo.listChannels(b.businessId);
    out.push({
      ...publicBusiness(b),
      blocked: blockSet.has(b.businessId),
      channels: channels.filter((c) => c.active).map((c) => ({ ...channelView(c), subscribed: subSet.has(c.channelId) })),
    });
  }
  return { businesses: out };
}

export async function subscribe(userId: string, businessId: string, channelId: string) {
  const business = await repo.findById(businessId);
  if (!business || business.status !== 'verified') throw appError('NOT_FOUND', 'Business not found.');
  const channel = await repo.findChannel(channelId);
  if (!channel || channel.businessId !== businessId || !channel.active) throw appError('NOT_FOUND', 'Channel not found.');
  const sub = await repo.subscribe(userId, businessId, channelId);
  return { subscriptionId: sub.subscriptionId, status: sub.status };
}

export async function unsubscribe(userId: string, subscriptionId: string) {
  if (!(await repo.unsubscribe(userId, subscriptionId))) throw appError('NOT_FOUND', 'Subscription not found.');
  return { unsubscribed: true };
}

export async function inbox(userId: string, limit: number, cursor?: string): Promise<{ items: repo.InboxItem[]; meta: PageMeta }> {
  const rows = await repo.inbox(userId, limit, decodeCursor(cursor));
  return buildPage(rows, limit, (r) => ({ t: r.createdAt.toISOString(), id: r.deliveryId }));
}

export async function block(userId: string, businessId: string, reason?: string) {
  if (!(await repo.findById(businessId))) throw appError('NOT_FOUND', 'Business not found.');
  await repo.block(userId, businessId, reason);
  return { blocked: true };
}

export async function unblock(userId: string, businessId: string) {
  await repo.unblock(userId, businessId);
  return { unblocked: true };
}

export async function report(userId: string, businessId: string, reason?: string) {
  if (!(await repo.findById(businessId))) throw appError('NOT_FOUND', 'Business not found.');
  await repo.report(userId, businessId, reason);
  return { reported: true };
}

// ── Business-facing (API key) ─────────────────────────────────────────────────

export function me(business: BusinessRow) {
  return { ...publicBusiness(business), plan: business.plan, contactEmail: business.contactEmail };
}

export async function createChannel(business: BusinessRow, input: { name: string; channelType: ChannelRow['channelType']; dailyLimitPerSubscriber?: number }) {
  const c = await repo.createChannel({ businessId: business.businessId, ...input });
  return channelView(c);
}

export async function channels(business: BusinessRow) {
  return { channels: (await repo.listChannels(business.businessId)).map(channelView) };
}

/** Broadcast to a channel: create the message, fan out deliveries + push, finalize. */
export async function broadcast(business: BusinessRow, channelId: string, content: string, templateId?: string) {
  const channel = await repo.findChannel(channelId);
  if (!channel || channel.businessId !== business.businessId) throw appError('NOT_FOUND', 'Channel not found.');
  if (!channel.active) throw appError('CONFLICT', 'Channel is inactive.');

  const subs = await repo.activeSubscribers(channelId, business.businessId);
  const message = await repo.createMessage({ channelId, businessId: business.businessId, content, templateId: templateId ?? null, totalSubscribers: subs.length });

  await repo.recordDeliveries(message.messageId, subs);
  let delivered = 0;
  for (const s of subs) {
    const { sent } = await notifications.notifyUser(
      s.userId,
      { title: business.name, body: content.slice(0, 140) },
      { category: 'company_updates', data: { type: 'business_message', businessId: business.businessId, messageId: message.messageId } },
    );
    if (sent >= 0) delivered++;
  }
  await repo.finalizeMessage(message.messageId, subs.length, 0);
  return { messageId: message.messageId, totalSubscribers: subs.length, delivered };
}

function messageView(m: MessageRow) {
  return { messageId: m.messageId, content: m.content, status: m.status, totalSubscribers: m.totalSubscribers, totalDelivered: m.totalDelivered, sentAt: m.sentAt, createdAt: m.createdAt };
}

export async function channelMessages(business: BusinessRow, channelId: string) {
  const channel = await repo.findChannel(channelId);
  if (!channel || channel.businessId !== business.businessId) throw appError('NOT_FOUND', 'Channel not found.');
  return { messages: (await repo.listChannelMessages(channelId)).map(messageView) };
}

// ── Counter QR (business shows QR → customer scans & confirms) ────────────────

export type CounterQrPayload = {
  businessId: string;
  channelId: string;
  businessName: string;
  channelName: string;
  channelType: string;
  logoUrl: string | null;
};

/** Mint a 60s single-use counter QR for the operator's selected channel. */
export async function mintCounterQr(business: BusinessRow, channelId: string) {
  const channel = await repo.findChannel(channelId);
  if (!channel || channel.businessId !== business.businessId) {
    throw appError('NOT_FOUND', 'Channel not found.');
  }
  if (!channel.active) throw appError('CONFLICT', 'Channel is inactive.');

  const token = crypto.randomUUID();
  const payload: CounterQrPayload = {
    businessId: business.businessId,
    channelId: channel.channelId,
    businessName: business.name,
    channelName: channel.name,
    channelType: channel.channelType,
    logoUrl: business.logoUrl,
  };
  await getRedis().set(keys.bizCounterQr(token), JSON.stringify(payload), 'EX', TTL.bizCounterQr);
  return {
    token,
    expiresIn: TTL.bizCounterQr,
    qrValue: `trustroute://biz/${token}`,
  };
}

async function peekCounterQr(token: string): Promise<CounterQrPayload | null> {
  const raw = await getRedis().get(keys.bizCounterQr(token));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CounterQrPayload;
  } catch {
    return null;
  }
}

async function consumeCounterQr(token: string): Promise<CounterQrPayload | null> {
  const redis = getRedis();
  const key = keys.bizCounterQr(token);
  const raw = await redis.get(key);
  if (!raw) return null;
  await redis.del(key);
  try {
    return JSON.parse(raw) as CounterQrPayload;
  } catch {
    return null;
  }
}

/** Peek counter QR for the confirmation dialog (does not consume). */
export async function resolveCounterQr(userId: string, token: string) {
  const payload = await peekCounterQr(token);
  if (!payload) {
    throw appError('BAD_REQUEST', 'This business QR is invalid or expired. Ask them to refresh it.');
  }
  if (await repo.isBlocked(userId, payload.businessId)) {
    throw appError('FORBIDDEN', 'You have blocked this business.');
  }
  const existing = await repo.findSubscription(userId, payload.channelId);
  return {
    businessId: payload.businessId,
    channelId: payload.channelId,
    businessName: payload.businessName,
    channelName: payload.channelName,
    channelType: payload.channelType,
    logoUrl: payload.logoUrl,
    alreadySubscribed: existing?.status === 'active',
    alreadyPending: existing?.status === 'pending',
    subscriptionId: existing?.subscriptionId ?? null,
    subscriptionStatus: existing?.status ?? null,
  };
}

/** Consume counter QR and create an active subscription after user confirmation. */
export async function subscribeCounterQr(userId: string, token: string) {
  const payload = await consumeCounterQr(token);
  if (!payload) {
    throw appError('BAD_REQUEST', 'This business QR is invalid or expired. Ask them to refresh it.');
  }
  if (await repo.isBlocked(userId, payload.businessId)) {
    throw appError('FORBIDDEN', 'You have blocked this business.');
  }

  const channel = await repo.findChannel(payload.channelId);
  if (!channel || channel.businessId !== payload.businessId) {
    throw appError('NOT_FOUND', 'Channel not found.');
  }
  if (!channel.active) throw appError('CONFLICT', 'This channel is no longer active.');

  const existing = await repo.findSubscription(userId, payload.channelId);
  if (existing?.status === 'active') {
    return {
      subscriptionId: existing.subscriptionId,
      status: 'active' as const,
      alreadySubscribed: true,
      businessId: payload.businessId,
      businessName: payload.businessName,
      channelId: payload.channelId,
      channelName: payload.channelName,
      channelType: payload.channelType,
      logoUrl: payload.logoUrl,
    };
  }

  const sub = await repo.subscribe(userId, payload.businessId, payload.channelId);
  return {
    subscriptionId: sub.subscriptionId,
    status: sub.status,
    alreadySubscribed: false,
    businessId: payload.businessId,
    businessName: payload.businessName,
    channelId: payload.channelId,
    channelName: payload.channelName,
    channelType: payload.channelType,
    logoUrl: payload.logoUrl,
    subscribedAt: sub.subscribedAt,
  };
}
