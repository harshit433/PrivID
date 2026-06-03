/**
 * worker/src/index.ts
 *
 * Entry point for the TrustRoute background worker process.
 *
 * Cron schedule:
 *   mass-outreach scan        every  5 min
 *   channel-expiry scan       every  5 min
 *   status-expiry scan        every  5 min
 *   connection-expiry scan    every 10 min
 *   ml-feedback scan          every  6 h
 *   shadow-score recompute    once nightly (02:00)
 *   token cleanup             once daily
 *
 * All cron ticks use per-period jobId deduplication so rapid restarts
 * (rolling deploys) cannot create duplicate work.
 */

import 'dotenv/config';
import path from 'path';
import fs from 'fs';

const envPath = path.resolve(__dirname, '../../api/.env');
if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath });

import { startTrustRecomputeWorker } from './jobs/trustRecompute';
import { startMassOutreachWorker, enqueueMassOutreachScan } from './jobs/massOutreach';
import { startChannelExpiryWorker, enqueueChannelExpiryScan } from './jobs/channelExpiry';
import { startConnectionExpiryWorker, enqueueConnectionExpiryScan } from './jobs/connectionExpiry';
import { startTokenRotationWorker, enqueueTokenRotation } from './jobs/tokenRotation';
import { startShadowScoreRecomputeWorker, enqueueShadowRecompute } from './jobs/shadowScoreRecompute';
import { startMLFeedbackWorker, enqueueMLFeedbackScan } from './jobs/mlFeedback';
import { startStatusExpiryWorker, enqueueStatusExpiryScan } from './jobs/statusExpiry';
import { isMLAvailable } from './utils/mlClient';
import { logger } from './utils/logger';

const WORKER = 'index';

async function main() {
  logger.info(WORKER, 'TrustRoute worker starting');

  // Probe ML service (informational — workers start regardless)
  const mlUp = await isMLAvailable();
  logger.info(WORKER, 'ML service probe', { available: mlUp });
  if (!mlUp) {
    logger.warn(WORKER, 'ML unavailable on startup — trust recompute will use verification-only scores until ML recovers');
  }

  // Start all workers
  const workers = [
    startTrustRecomputeWorker(),
    startMassOutreachWorker(),
    startChannelExpiryWorker(),
    startConnectionExpiryWorker(),
    startTokenRotationWorker(),
    startShadowScoreRecomputeWorker(),
    startMLFeedbackWorker(),
    startStatusExpiryWorker(),
  ];

  logger.info(WORKER, `${workers.length} workers running`);

  // Run startup scans immediately to catch any backlog from downtime
  await Promise.allSettled([
    enqueueChannelExpiryScan(),
    enqueueConnectionExpiryScan(),
    enqueueTokenRotation(),
    enqueueMLFeedbackScan(),
    enqueueStatusExpiryScan(),
  ]);

  // ── Cron ticks ───────────────────────────────────────────────────────────

  function cron(label: string, fn: () => Promise<void>, intervalMs: number) {
    setInterval(() => {
      fn().catch((e: Error) =>
        logger.error(WORKER, `Failed to enqueue ${label}`, { error: e.message })
      );
    }, intervalMs);
  }

  cron('mass-outreach scan',      enqueueMassOutreachScan,      5  * 60 * 1_000);
  cron('channel-expiry scan',     enqueueChannelExpiryScan,     5  * 60 * 1_000);
  cron('connection-expiry scan',  enqueueConnectionExpiryScan,  10 * 60 * 1_000);
  cron('status-expiry scan',      enqueueStatusExpiryScan,      5  * 60 * 1_000);
  cron('ml-feedback scan',        enqueueMLFeedbackScan,        6  * 60 * 60 * 1_000);
  cron('token cleanup',           enqueueTokenRotation,         24 * 60 * 60 * 1_000);

  // Shadow recompute runs nightly at 02:00 UTC (approximate — checked every hour)
  scheduleNightly(2, enqueueShadowRecompute, 'shadow-recompute');

  // ── Graceful shutdown ─────────────────────────────────────────────────────

  async function shutdown(signal: string) {
    logger.info(WORKER, `Received ${signal} — shutting down gracefully`);
    try {
      await Promise.all(workers.map((w) => w.close()));
      logger.info(WORKER, 'All workers closed cleanly');
    } catch (err: any) {
      logger.error(WORKER, 'Error during shutdown', { error: err.message });
    } finally {
      process.exit(0);
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.error(WORKER, 'Uncaught exception', { error: err.message, stack: err.stack });
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error(WORKER, 'Unhandled rejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
  });
}

/**
 * scheduleNightly — check once per hour whether the target hour (UTC) has
 * arrived and enqueue the job with a stable daily jobId.
 */
function scheduleNightly(hourUtc: number, fn: () => Promise<void>, label: string) {
  const check = () => {
    if (new Date().getUTCHours() === hourUtc) {
      fn().catch((e: Error) =>
        logger.error(WORKER, `Failed to enqueue nightly ${label}`, { error: e.message })
      );
    }
  };
  check(); // run once on startup in case the process started at the right hour
  setInterval(check, 60 * 60 * 1_000); // check every hour
}

main().catch((err) => {
  logger.error(WORKER, 'Fatal startup error', { error: err.message, stack: err.stack });
  process.exit(1);
});
