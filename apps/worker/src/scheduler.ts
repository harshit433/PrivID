/**
 * Cron scheduler. Periodically enqueues the scan jobs that reconcile time-based state.
 * Each tick uses a period-bucketed jobId so overlapping ticks (or a rolling deploy with
 * two schedulers briefly live) can't double-schedule the same window.
 */
import { enqueue, logger } from '@trustroute/core';
import { enqueueMassOutreachScan } from './jobs/massOutreach';
import { enqueueDueBusinessMessages } from './jobs/businessMessageDeliver';
import { enqueueStuckExports } from './jobs/dataExport';

const MIN = 60_000;
const HOUR = 60 * MIN;

type Tick = { label: string; run: () => Promise<void>; intervalMs: number };

/** Enqueue a singleton scan job, deduped to one per `bucketMs` window. */
function scan(name: Parameters<typeof enqueue>[0], bucketMs: number): () => Promise<void> {
  return () => enqueue(name, {} as never, { jobId: `${name}-${Math.floor(Date.now() / bucketMs)}` });
}

const ticks: Tick[] = [
  { label: 'business-scheduled', run: enqueueDueBusinessMessages, intervalMs: 1 * MIN },
  { label: 'mass-outreach', run: enqueueMassOutreachScan, intervalMs: 5 * MIN },
  { label: 'channel-expiry', run: scan('channel-expiry', 5 * MIN), intervalMs: 5 * MIN },
  { label: 'status-expiry', run: scan('status-expiry', 5 * MIN), intervalMs: 5 * MIN },
  { label: 'handle-propagation', run: scan('handle-propagation', 5 * MIN), intervalMs: 5 * MIN },
  { label: 'connection-expiry', run: scan('connection-expiry', 10 * MIN), intervalMs: 10 * MIN },
  { label: 'data-export-backstop', run: enqueueStuckExports, intervalMs: 15 * MIN },
  { label: 'referral-qualification', run: scan('referral-qualification', HOUR), intervalMs: HOUR },
  { label: 'ml-feedback', run: scan('ml-feedback', 6 * HOUR), intervalMs: 6 * HOUR },
  { label: 'token-rotation', run: scan('token-rotation', 24 * HOUR), intervalMs: 24 * HOUR },
  { label: 'shadow-recompute', run: scan('shadow-recompute', 24 * HOUR), intervalMs: 24 * HOUR },
];

/** Start all cron ticks; returns a stop function. */
export function startScheduler(): () => void {
  const timers = ticks.map((t) =>
    setInterval(() => {
      t.run().catch((e: Error) => logger.error('scheduler', `enqueue ${t.label} failed`, { error: e.message }));
    }, t.intervalMs),
  );
  logger.info('scheduler', `${ticks.length} cron ticks scheduled`);
  return () => timers.forEach(clearInterval);
}
