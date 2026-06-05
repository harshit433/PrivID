import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import { authRouter } from './routes/auth';
import { usersRouter } from './routes/users';
import { connectionsRouter } from './routes/connections';
import { callsRouter } from './routes/calls';
import { channelsRouter } from './routes/channels';
import { chatRouter } from './routes/chat';
import { trustRouter } from './routes/trust';
import { livenessRouter } from './routes/liveness';
import { simulationRouter } from './routes/simulation';
import { numbersRouter } from './routes/numbers';
import { statusRouter } from './routes/status';
import { subscriptionsRouter } from './routes/subscriptions';
import { businessRegisterRouter } from './routes/businessRegister';
import { adminRouter } from './routes/admin';
import { activitiesRouter } from './routes/activities';
import {
  mountBusinessSuite,
  routeByApiKey,
  businessChannelsRouter,
  businessSubscriptionsRouter,
} from './mountBusinessSuite';
import { errorHandler } from './middleware/errorHandler';
import { apiLimiter, publicLimiter } from './middleware/rateLimit';
import { getPool, connectRedis, getRedis } from '@trustroute/shared';
import { isThreediviConfigured } from './services/threedivi';
import { isStreamConfigured } from './services/stream';
import { isLivenessConfigured } from './services/liveness';
import {
  isPlayIntegrityConfigured,
  isPlayIntegrityStrict,
  isPlayIntegritySideloadAllowed,
} from './services/playIntegrity';
import { logger } from './utils/logger';

const app = express();
const PORT = parseInt(process.env.API_PORT ?? '3000', 10);
const JSON_LIMIT_DEFAULT = process.env.EXPRESS_JSON_LIMIT ?? '1mb';
const JSON_LIMIT_LARGE = process.env.EXPRESS_JSON_LARGE_LIMIT ?? '15mb';

function pathNeedsLargeJsonBody(path: string): boolean {
  return (
    path === '/trust/verify/liveness/complete' ||
    path === '/users/me/avatar' ||
    path.startsWith('/status')
  );
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet());

const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Mobile apps send no Origin header — always allow
    if (!origin) return callback(null, true);
    // In dev, allow everything
    if (process.env.NODE_ENV !== 'production') return callback(null, true);
    // In prod, require explicit allowlist via env var
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));
// Capture the raw body so the Stream chat webhook can verify its HMAC signature.
// Most routes use a 1 MB cap; media upload routes opt into a larger limit.
app.use((req, res, next) => {
  const limit = pathNeedsLargeJsonBody(req.path) ? JSON_LIMIT_LARGE : JSON_LIMIT_DEFAULT;
  express.json({
    limit,
    verify: (_req, _res, buf) => { (req as any).rawBody = buf; },
  })(req, res, next);
});
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    await getPool().query('SELECT 1');
    let redis_ok = false;
    try {
      await getRedis().ping();
      redis_ok = true;
    } catch {
      redis_ok = false;
    }
    res.json({
      ok: true,
      service: 'api',
      ts: new Date().toISOString(),
      redis_ok,
      threedivi_configured: isThreediviConfigured(),
      threedivi_runner: process.env.THREEDIVI_RUNNER ?? 'auto',
      stream_chat_configured: isStreamConfigured(),
      liveness_configured: isLivenessConfigured(),
      play_integrity_configured: isPlayIntegrityConfigured(),
      play_integrity_strict: isPlayIntegrityStrict(),
      play_integrity_allow_sideload: isPlayIntegritySideloadAllowed(),
    });
  } catch (err) {
    res.status(503).json({ ok: false, error: 'DB unavailable' });
  }
});

// ─── Debug: call system health (dev/staging only) ─────────────────────────────
app.get('/debug/call-health', async (_req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ ok: false, error: 'Not found' });
  }
  const { testRtdbWrite } = await import('./services/fcm');
  const { getPool } = await import('@trustroute/shared');

  const firebaseConfigured = !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const rtdbUrl = process.env.FIREBASE_DATABASE_URL ?? 'https://privid-cb3bf-default-rtdb.firebaseio.com';

  let rtdbStatus = '⏳ not tested';
  let usersWithToken = 0;
  let usersWithoutToken = 0;
  let recentCalls: any[] = [];

  try {
    const pool = getPool();
    const [r1, r2, r3] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM users WHERE fcm_token IS NOT NULL`),
      pool.query(`SELECT COUNT(*) FROM users WHERE fcm_token IS NULL`),
      pool.query(`SELECT call_id, status, created_at FROM calls ORDER BY created_at DESC LIMIT 5`),
    ]);
    usersWithToken    = parseInt(r1.rows[0].count);
    usersWithoutToken = parseInt(r2.rows[0].count);
    recentCalls = r3.rows;
  } catch (err: any) {
    recentCalls = [{ db_error: err?.message }];
  }

  try {
    await testRtdbWrite();
    rtdbStatus = '✅ working';
  } catch (err: any) {
    rtdbStatus = `❌ ${err?.message}`;
  }

  res.json({
    firebase_configured: firebaseConfigured ? '✅ SET' : '❌ MISSING',
    rtdb_url: rtdbUrl,
    rtdb_write: rtdbStatus,
    users_with_fcm_token:    usersWithToken,
    users_without_fcm_token: usersWithoutToken,
    action_needed: usersWithToken === 0
      ? '⚠️ No FCM tokens registered — all users must open v1.9 of the app first'
      : `✅ ${usersWithToken} user(s) ready to receive calls`,
    recent_calls: recentCalls,
  });
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/register', publicLimiter, businessRegisterRouter);
app.use('/auth', publicLimiter, authRouter);
app.use('/users', apiLimiter, usersRouter);
app.use('/connections', apiLimiter, connectionsRouter);
app.use('/status', apiLimiter, statusRouter);
app.use(
  '/subscriptions',
  apiLimiter,
  routeByApiKey(businessSubscriptionsRouter, subscriptionsRouter),
);
app.use('/calls', apiLimiter, callsRouter);
app.use('/activities', apiLimiter, activitiesRouter);
app.use('/channels', apiLimiter, routeByApiKey(businessChannelsRouter, channelsRouter));
// Stream calls /chat/webhook server-to-server (no user) — exempt it from the
// per-user limiter; all other /chat routes are authenticated + rate limited.
app.use('/chat', (req, res, next) => {
  if (req.path === '/webhook') return next();
  return apiLimiter(req, res, next);
}, chatRouter);
app.use('/trust', apiLimiter, trustRouter);
// The liveness web page is loaded inside a WebView (no auth header / not a
// per-user API call), so it is public and exempt from the API rate limiter.
app.use('/liveness', livenessRouter);
// Shadow trust: observe + query shadow scores for non-TrustRoute numbers
app.use('/numbers', apiLimiter, numbersRouter);
// Admin: internal-only, gated by x-admin-key (should be behind VPN in prod)
app.use('/admin', publicLimiter, adminRouter);
// Business suite (API key auth) — same routes as business-api :3002
mountBusinessSuite(app);
if (process.env.NODE_ENV !== 'production') {
  app.use('/simulation', simulationRouter);
}

// ─── Error handler ────────────────────────────────────────────────────────────
app.use(errorHandler);

async function startServer(): Promise<void> {
  try {
    await connectRedis();
  } catch (err) {
    console.warn('[API] Starting without Redis — rate limits and SIM SMS may fail until Redis is up:', err);
  }

  app.listen(PORT, '0.0.0.0', () => {
    logger.debug('API', `Running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[API] Failed to start', err);
  process.exit(1);
});

export { app };
