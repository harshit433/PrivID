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
import { trustRouter } from './routes/trust';
import { simulationRouter } from './routes/simulation';
import { errorHandler } from './middleware/errorHandler';
import { apiLimiter, publicLimiter } from './middleware/rateLimit';
import { getPool } from '@privid/shared';
import { isThreediviConfigured } from './services/threedivi';

const app = express();
const PORT = parseInt(process.env.API_PORT ?? '3000', 10);
const JSON_LIMIT = process.env.EXPRESS_JSON_LIMIT ?? '15mb';

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: JSON_LIMIT }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    await getPool().query('SELECT 1');
    res.json({
      ok: true,
      service: 'api',
      ts: new Date().toISOString(),
      threedivi_configured: isThreediviConfigured(),
      threedivi_runner: process.env.THREEDIVI_RUNNER ?? 'auto',
    });
  } catch (err) {
    res.status(503).json({ ok: false, error: 'DB unavailable' });
  }
});

// ─── Debug: call system health ────────────────────────────────────────────────
// Shows exactly what's configured so issues can be diagnosed instantly.
app.get('/debug/call-health', async (_req, res) => {
  const firebaseConfigured = !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const rtdbUrl = process.env.FIREBASE_DATABASE_URL ?? 'https://privid-cb3bf-default-rtdb.firebaseio.com';

  // Count users with FCM tokens
  let usersWithToken = 0;
  let recentCalls = [];
  try {
    const { getPool } = await import('@privid/shared');
    const pool = getPool();
    const r1 = await pool.query(`SELECT COUNT(*) FROM users WHERE fcm_token IS NOT NULL`);
    usersWithToken = parseInt(r1.rows[0].count);
    const r2 = await pool.query(
      `SELECT call_id, status, created_at, caller_id, callee_id FROM calls ORDER BY created_at DESC LIMIT 5`
    );
    recentCalls = r2.rows;
  } catch (err: any) {
    recentCalls = [{ error: err?.message }] as any;
  }

  // Test RTDB write
  let rtdbWorking = false;
  if (firebaseConfigured) {
    try {
      const admin = await import('firebase-admin');
      if (admin.default.apps.length > 0) {
        await admin.default.database().ref('_health').set({ ts: Date.now() });
        rtdbWorking = true;
      }
    } catch { rtdbWorking = false; }
  }

  res.json({
    firebase_service_account: firebaseConfigured ? '✅ SET' : '❌ MISSING — FCM + RTDB disabled',
    rtdb_url: rtdbUrl,
    rtdb_write_test: rtdbWorking ? '✅ working' : '❌ failed (check FIREBASE_SERVICE_ACCOUNT_JSON)',
    users_with_fcm_token: usersWithToken,
    recent_calls: recentCalls,
  });
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/auth', publicLimiter, authRouter);
app.use('/users', apiLimiter, usersRouter);
app.use('/connections', apiLimiter, connectionsRouter);
app.use('/calls', apiLimiter, callsRouter);
app.use('/channels', apiLimiter, channelsRouter);
app.use('/trust', apiLimiter, trustRouter);
app.use('/simulation', simulationRouter);

// ─── Error handler ────────────────────────────────────────────────────────────
app.use(errorHandler);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[API] Running on http://0.0.0.0:${PORT}`);
});

export { app };
