/**
 * Background worker entrypoint. Registers BullMQ processors and the cron scheduler.
 * Job processors are added in P8; P0 establishes the process + graceful lifecycle.
 */
import 'dotenv/config';
import { connectRedis, logger } from '@trustroute/core';
import { startWorkers } from './workers';
import { startScheduler } from './scheduler';

async function main(): Promise<void> {
  logger.info('worker', 'starting');
  await connectRedis();

  const workers = startWorkers();
  const stopScheduler = startScheduler();
  logger.info('worker', `${workers.length} processors running`);

  async function shutdown(signal: string): Promise<void> {
    logger.info('worker', `received ${signal}, shutting down`);
    stopScheduler();
    await Promise.allSettled(workers.map((w) => w.close()));
    process.exit(0);
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    logger.error('worker', 'uncaught exception', { error: err.message, stack: err.stack });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('worker', 'unhandled rejection', { reason: reason instanceof Error ? reason.message : String(reason) });
  });
}

main().catch((err) => {
  logger.error('worker', 'fatal startup error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
