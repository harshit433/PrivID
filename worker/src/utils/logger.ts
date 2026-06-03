/**
 * worker/src/utils/logger.ts
 *
 * Structured JSON logger for the background worker process.
 * Keeps the same field shape as the API's logger so log aggregators
 * (Datadog, Loki, CloudWatch) parse both services identically.
 *
 * Usage:
 *   logger.info('connection-expiry', 'Downgraded 12 connections');
 *   logger.error('trust-recompute', 'ML unavailable', { user_id, err: e.message });
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function emit(level: LogLevel, job: string, msg: string, meta?: Record<string, unknown>) {
  const entry = {
    ts:    new Date().toISOString(),
    level,
    svc:   'worker',
    job,
    msg,
    ...(meta ?? {}),
  };

  const line = JSON.stringify(entry);

  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export const logger = {
  debug: (job: string, msg: string, meta?: Record<string, unknown>) => emit('debug', job, msg, meta),
  info:  (job: string, msg: string, meta?: Record<string, unknown>) => emit('info',  job, msg, meta),
  warn:  (job: string, msg: string, meta?: Record<string, unknown>) => emit('warn',  job, msg, meta),
  error: (job: string, msg: string, meta?: Record<string, unknown>) => emit('error', job, msg, meta),
};
