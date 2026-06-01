"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.keys = void 0;
exports.getRedis = getRedis;
const ioredis_1 = __importDefault(require("ioredis"));
let client = null;
function getRedis() {
    if (!client) {
        client = new ioredis_1.default(process.env.REDIS_URL ?? 'redis://localhost:6379', {
            maxRetriesPerRequest: 3,
            lazyConnect: true,
        });
        client.on('error', (err) => {
            console.error('[Redis] Connection error', err);
        });
    }
    return client;
}
// Key helpers — centralized so nothing is spelled inconsistently
exports.keys = {
    otpSession: (sessionId) => `otp:session:${sessionId}`,
    refreshToken: (tokenHash) => `refresh:${tokenHash}`,
    rateLimitOtp: (phone) => `ratelimit:otp:${phone}`,
    rateLimitCall: (userId, targetId) => `ratelimit:call:${userId}:${targetId}`,
    reachabilityToken: (token) => `reach:token:${token}`,
    userSession: (userId) => `user:session:${userId}`,
    /** Pending MSG91 signup after OTP verified (handle not chosen yet). TTL ~15 min. */
    msg91SignupPending: (signupToken) => `msg91:signup:${signupToken}`,
    /** SIM SMS binding challenge for authenticated user. TTL 2 min. */
    simSmsChallenge: (userId) => `sim_sms:${userId}`,
    rateLimitSimSms: (phone) => `ratelimit:sim_sms:${phone}`,
};
