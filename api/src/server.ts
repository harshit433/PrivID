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

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/auth', publicLimiter, authRouter);
app.use('/users', apiLimiter, usersRouter);
app.use('/connections', apiLimiter, connectionsRouter);
app.use('/calls', apiLimiter, callsRouter);
app.use('/channels', apiLimiter, channelsRouter);
app.use('/trust', apiLimiter, trustRouter);

// ─── Error handler ────────────────────────────────────────────────────────────
app.use(errorHandler);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[API] Running on http://0.0.0.0:${PORT}`);
});

export { app };
