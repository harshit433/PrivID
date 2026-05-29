import 'dotenv/config';
import path from 'path';
import fs from 'fs';

// Load .env from parent api directory if not already set
const envPath = path.resolve(__dirname, '../../api/.env');
if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath });

import { startTrustRecomputeWorker } from './jobs/trustRecompute';
import { startMassOutreachWorker, enqueueMassOutreachScan } from './jobs/massOutreach';
import { startChannelExpiryWorker, enqueueChannelExpiryScan } from './jobs/channelExpiry';
import { startTokenRotationWorker, enqueueTokenRotation } from './jobs/tokenRotation';

console.log('[worker] Starting PrivID workers...');

// ─── Start all workers ────────────────────────────────────────────────────────
const workers = [
  startTrustRecomputeWorker(),
  startMassOutreachWorker(),
  startChannelExpiryWorker(),
  startTokenRotationWorker(),
];

console.log(`[worker] ${workers.length} workers running`);

// ─── Cron schedules ───────────────────────────────────────────────────────────

// Mass outreach: check every 5 minutes
setInterval(() => enqueueMassOutreachScan().catch(console.error), 5 * 60 * 1000);

// Channel expiry: check every 5 minutes
setInterval(() => enqueueChannelExpiryScan().catch(console.error), 5 * 60 * 1000);

// Token cleanup: once per day
setInterval(() => enqueueTokenRotation().catch(console.error), 24 * 60 * 60 * 1000);

// Run immediately on startup
enqueueChannelExpiryScan().catch(console.error);
enqueueTokenRotation().catch(console.error);

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown() {
  console.log('[worker] Shutting down...');
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
