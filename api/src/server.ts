import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import { authRouter } from './routes/auth';
import { onboardingRouter } from './routes/onboarding';
import { usersRouter } from './routes/users';
import { meRouter } from './routes/me';
import { connectionsRouter } from './routes/connections';
import { callsRouter } from './routes/calls';
import { channelsRouter } from './routes/channels';
import { chatRouter } from './routes/chat';
import { trustRouter } from './routes/trust';
import { livenessRouter } from './routes/liveness';
import { simulationRouter } from './routes/simulation';
import { timeseriesRouter } from './routes/timeseriesSim';
import { numbersRouter } from './routes/numbers';
import { statusRouter } from './routes/status';
import { subscriptionsRouter } from './routes/subscriptions';
import { businessRegisterRouter } from './routes/businessRegister';
import { adminRouter } from './routes/admin';
import { activitiesRouter } from './routes/activities';
import { referralsRouter } from './routes/referrals';
import { reportsRouter } from './routes/reports';
import { payoutMethodsRouter } from './routes/payoutMethods';
import { payoutsRouter } from './routes/payouts';
import { configRouter } from './routes/config';
import { walletRouter } from './routes/wallet';
import { maskedRouter } from './routes/masked';
import { sharesRouter } from './routes/shares';
import { chatsRouter } from './routes/chats';
import { mediaRouter } from './routes/media';
import {
  paymentsRouter,
  telephonyRouter,
  privacySubscriptionRouter,
  publicReportRouter,
} from './routes/payments';
import {
  mountBusinessSuite,
  routeByApiKey,
  businessChannelsRouter,
  businessSubscriptionsRouter,
  businessMeAuthedRouter,
} from './mountBusinessSuite';
import { errorHandler } from './middleware/errorHandler';
import { requestIdMiddleware } from './middleware/requestId';
import { apiLimiter, publicLimiter } from './middleware/rateLimit';
import { getPool, connectRedis, getRedis } from '@trustroute/shared';
import { isStreamConfigured } from './services/stream';
import { isLivenessConfigured } from './services/liveness';
import { isDigilockerConfigured } from './services/digilocker';
import { digilockerCallbackRouter } from './routes/digilockerCallback';
import { logger } from './utils/logger';

const app = express();
const PORT = parseInt(process.env.PORT ?? process.env.API_PORT ?? '3000', 10);
const JSON_LIMIT_DEFAULT = process.env.EXPRESS_JSON_LIMIT ?? '1mb';
const JSON_LIMIT_LARGE = process.env.EXPRESS_JSON_LARGE_LIMIT ?? '15mb';

function pathNeedsLargeJsonBody(path: string): boolean {
  return (
    path === '/onboarding/liveness/complete' ||
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

// Browser requests from our own hosted pages (e.g. simulation live dashboard) send
// an Origin header matching the API host — allow without adding to the allowlist.
const SELF_ORIGINS = [
  process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null,
  process.env.API_BASE_URL?.replace(/\/$/, '') ?? null,
].filter((o): o is string => Boolean(o));

app.use(cors({
  origin: (origin, callback) => {
    // Mobile apps send no Origin header — always allow
    if (!origin) return callback(null, true);
    // In dev, allow everything
    if (process.env.NODE_ENV !== 'production') return callback(null, true);
    // Same-origin browser traffic to this API (simulation dashboard, etc.)
    if (SELF_ORIGINS.includes(origin)) return callback(null, true);
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
app.use(requestIdMiddleware);

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/favicon.ico', (_req, res) => res.status(204).end());
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
      stream_chat_configured: isStreamConfigured(),
      liveness_configured: isLivenessConfigured(),
      digilocker_configured: isDigilockerConfigured(),
    });
  } catch (err) {
    res.status(503).json({ ok: false, error: 'DB unavailable' });
  }
});

// Temporary DigiLocker egress probe (remove after Setu allowlisting).
app.get('/debug/digilocker-egress', async (_req, res) => {
  if (process.env.ENABLE_DIGILOCKER_EGRESS_DEBUG !== 'true') {
    return res.status(404).json({ ok: false, error: 'Not found' });
  }
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  const cfg = {
    base: (process.env.SETU_DG_BASE_URL || 'https://dg-sandbox.setu.co').replace(/\/$/, ''),
    id: process.env.SETU_DG_CLIENT_ID || '',
    secret: process.env.SETU_DG_CLIENT_SECRET || '',
    product: process.env.SETU_DG_PRODUCT_INSTANCE_ID || '',
    redirect: process.env.SETU_DG_REDIRECT_URL || '',
  };
  try {
    const { stdout, stderr } = await execFileAsync(
      'curl',
      [
        '-sS',
        '-o',
        '-',
        '-w',
        '\nHTTP_CODE:%{http_code}',
        '--max-time',
        '20',
        '-X',
        'POST',
        `${cfg.base}/api/digilocker`,
        '-H',
        'Content-Type: application/json',
        '-H',
        `x-client-id: ${cfg.id}`,
        '-H',
        `x-client-secret: ${cfg.secret}`,
        '-H',
        `x-product-instance-id: ${cfg.product}`,
        '-d',
        JSON.stringify({ redirectUrl: cfg.redirect }),
      ],
      { timeout: 25_000, maxBuffer: 64_000 },
    );
    const parts = String(stdout).split('\nHTTP_CODE:');
    const body = parts[0] ?? '';
    const code = Number(parts[1] || 0);
    res.json({
      ok: code >= 200 && code < 300,
      via: 'curl',
      http: code,
      bodyPreview: body.slice(0, 240),
      stderr: String(stderr || '').slice(0, 200),
      clientIdPrefix: cfg.id.slice(0, 8),
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      via: 'curl',
      error: err instanceof Error ? err.message : String(err),
      clientIdPrefix: cfg.id.slice(0, 8),
    });
  }
});

// DigiLocker OAuth return (Setu redirects here when SETU_DG_REDIRECT_URL points at the API).
app.use('/digilocker', publicLimiter, digilockerCallbackRouter);

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
app.use('/onboarding', publicLimiter, onboardingRouter);
app.use('/users', apiLimiter, usersRouter);
// Consumer JWT /me vs business API-key /me — same dual-mount pattern as /channels.
app.use('/me', apiLimiter, routeByApiKey(businessMeAuthedRouter, meRouter));
app.use('/connections', apiLimiter, connectionsRouter);
app.use('/status', apiLimiter, statusRouter);
app.use(
  '/subscriptions',
  apiLimiter,
  routeByApiKey(businessSubscriptionsRouter, subscriptionsRouter),
);
app.use('/calls', apiLimiter, callsRouter);
app.use('/activities', apiLimiter, activitiesRouter);
app.use('/referrals', apiLimiter, referralsRouter);
app.use('/reports', apiLimiter, reportsRouter);
app.use('/payout-methods', apiLimiter, payoutMethodsRouter);
app.use('/payouts', apiLimiter, payoutsRouter);
app.use('/config', publicLimiter, configRouter);
app.use('/wallet', apiLimiter, walletRouter);
app.use('/masked', apiLimiter, maskedRouter);
app.use('/shares', apiLimiter, sharesRouter);
app.use('/chats', apiLimiter, chatsRouter);
app.use('/media', apiLimiter, mediaRouter);
app.use('/subscription', apiLimiter, privacySubscriptionRouter);
app.use('/payments', publicLimiter, paymentsRouter);
app.use('/telephony', publicLimiter, telephonyRouter);
app.use('/r', publicLimiter, publicReportRouter);
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
// Simulation routes are non-production only, but can be enabled in production
// on demand (e.g. to generate ML training data) via ENABLE_SIMULATION=true.
if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_SIMULATION === 'true') {
  app.use('/simulation', simulationRouter);
  app.use('/simulation/timeseries', timeseriesRouter);
}

// ─── Error handler ────────────────────────────────────────────────────────────
app.use(errorHandler);

async function startServer(): Promise<void> {
  try {
    await connectRedis();
  } catch (err) {
    console.warn('[API] Starting without Redis — rate limits and short-lived security state may fail until Redis is up:', err);
  }

  const httpServer = http.createServer(app);
  const { attachChatWebSocket } = await import('./services/chatWsGateway');
  attachChatWebSocket(httpServer);

  httpServer.listen(PORT, '0.0.0.0', () => {
    logger.debug('API', `Running on http://0.0.0.0:${PORT} (WS /ws/chat)`);
  });
}

startServer().catch((err) => {
  console.error('[API] Failed to start', err);
  process.exit(1);
});

export { app };
