"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.keys = void 0;
exports.resolveRedisUrl = resolveRedisUrl;
exports.getRedis = getRedis;
exports.connectRedis = connectRedis;
const ioredis_1 = __importDefault(require("ioredis"));
let client = null;
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Prefer Railway private networking when available. */
function resolveRedisUrl() {
    return process.env.REDIS_PRIVATE_URL ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
}
function getRedis() {
    if (!client) {
        client = new ioredis_1.default(resolveRedisUrl(), {
            maxRetriesPerRequest: 3,
            lazyConnect: true,
            connectTimeout: 10_000,
            retryStrategy: (times) => {
                if (times > 30)
                    return null;
                return Math.min(times * 200, 3_000);
            },
            reconnectOnError: (err) => {
                const msg = err.message ?? '';
                return (msg.includes('READONLY') ||
                    msg.includes('ECONNREFUSED') ||
                    msg.includes('ETIMEDOUT') ||
                    msg.includes('EHOSTUNREACH'));
            },
        });
        client.on('error', (err) => {
            // Transient during Railway redeploys — connectRedis() handles startup.
            console.error('[Redis] Connection error', err.message ?? err);
        });
    }
    return client;
}
/** Block until Redis accepts connections (Railway API often starts before Redis). */
async function connectRedis(maxAttempts = 30, delayMs = 2_000) {
    const redis = getRedis();
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            if (redis.status === 'wait' || redis.status === 'end') {
                await redis.connect();
            }
            await redis.ping();
            console.log(`[Redis] Connected (${attempt === 1 ? 'immediate' : `attempt ${attempt}`})`);
            return;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (attempt >= maxAttempts) {
                throw new Error(`Redis unavailable after ${maxAttempts} attempts: ${message}`);
            }
            console.warn(`[Redis] Not ready (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms…`);
            await sleep(delayMs);
        }
    }
}
// Key helpers — centralized so nothing is spelled inconsistently
exports.keys = {
    refreshToken: (tokenHash) => `refresh:${tokenHash}`,
    rateLimitCall: (userId, targetId) => `ratelimit:call:${userId}:${targetId}`,
    reachabilityToken: (token) => `reach:token:${token}`,
    userSession: (userId) => `user:session:${userId}`,
    presence: (userId) => `presence:${userId}`,
    trustScore: (userId) => `trust_score:${userId}`,
    shadowCaller: (phoneHash) => `shadow:caller:${phoneHash}`,
    mlFeedbackSent: (userId) => `ml:feedback:${userId}`,
    bizQr: (token) => `biz_qr:${token}`,
    bizApiRate: (businessId) => `ratelimit:biz_api:${businessId}`,
};
