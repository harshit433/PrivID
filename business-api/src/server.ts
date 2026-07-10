import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { connectRedis, getPool } from '@trustroute/shared';
import { errorHandler } from './middleware/errorHandler';
import { businessApiRateLimit } from './middleware/rateLimit';
import { registerRouter } from './routes/register';
import { meRouter } from './routes/me';
import { channelsRouter } from './routes/channels';
import { subscriptionsRouter } from './routes/subscriptions';
import { messagesRouter } from './routes/messages';
import { analyticsRouter } from './routes/analytics';
import { logger } from './utils/logger';

const envPath = path.resolve(__dirname, '../../api/.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

const app = express();
const PORT = parseInt(process.env.PORT ?? process.env.BUSINESS_API_PORT ?? '3002', 10);

app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

app.get('/health', async (_req, res) => {
  try {
    await getPool().query('SELECT 1');
    res.json({ ok: true, service: 'business-api', ts: new Date().toISOString() });
  } catch {
    res.status(503).json({ ok: false, service: 'business-api' });
  }
});

app.use('/register', registerRouter);

const authed = express.Router();
authed.use(businessApiRateLimit);
authed.use('/me', meRouter);
authed.use('/channels', channelsRouter);
authed.use('/subscriptions', subscriptionsRouter);
authed.use('/messages', messagesRouter);
authed.use('/analytics', analyticsRouter);

app.use(authed);
app.use(errorHandler);

async function start() {
  try {
    await connectRedis();
  } catch (err) {
    logger.warn('startup', 'Redis connect failed — rate limits / QR scan may fail', err);
  }

  app.listen(PORT, '0.0.0.0', () => {
    logger.info('startup', `Business API on http://0.0.0.0:${PORT}`);
  });
}

start().catch((err) => {
  console.error('[business-api] Failed to start', err);
  process.exit(1);
});

export { app };
