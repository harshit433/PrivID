/**
 * API entrypoint. Loads env, validates config, connects Redis (best-effort), then
 * listens. Domain wiring that needs the DB (e.g. auth guard hooks) is initialised
 * in `bootstrap()` before the server accepts traffic.
 */
import 'dotenv/config';
import http from 'http';
import { config, connectRedis, logger } from '@trustroute/core';
import { createApp } from './app';
import { bootstrap } from './bootstrap';

async function start(): Promise<void> {
  // Fail fast on bad config before doing anything else.
  logger.info('api', `starting in ${config.NODE_ENV}`);

  try {
    await connectRedis();
  } catch (err) {
    logger.warn('api', 'starting without Redis — rate limits/idempotency degrade until it recovers', {
      error: (err as Error).message,
    });
  }

  await bootstrap();

  const app = createApp();
  const server = http.createServer(app);
  server.listen(config.PORT, '0.0.0.0', () => {
    logger.info('api', `listening on http://0.0.0.0:${config.PORT}`);
  });

  const shutdown = (signal: string) => {
    logger.info('api', `received ${signal}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  logger.error('api', 'failed to start', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
