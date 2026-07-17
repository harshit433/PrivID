/**
 * Minimal structured logger. JSON lines in production (easy to ship to a log
 * aggregator), human-friendly in dev. Correlate lines with a requestId when one
 * is available on the call site.
 */
import { loadConfig } from '../config';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function minLevel(): LogLevel {
  return loadConfig().isProd ? 'info' : 'debug';
}

export interface LogFields {
  requestId?: string;
  [key: string]: unknown;
}

function emit(level: LogLevel, scope: string, message: string, fields?: LogFields): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel()]) return;

  if (loadConfig().isProd) {
    process.stdout.write(
      `${JSON.stringify({ ts: new Date().toISOString(), level, scope, message, ...fields })}\n`,
    );
    return;
  }
  const tag = { debug: '·', info: 'ℹ', warn: '⚠', error: '✖' }[level];
  const extra = fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';
  const line = `${tag} [${scope}] ${message}${extra}`;
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export interface Logger {
  debug(scope: string, message: string, fields?: LogFields): void;
  info(scope: string, message: string, fields?: LogFields): void;
  warn(scope: string, message: string, fields?: LogFields): void;
  error(scope: string, message: string, fields?: LogFields): void;
  child(baseFields: LogFields): Logger;
}

function make(base: LogFields = {}): Logger {
  const merge = (f?: LogFields) => ({ ...base, ...f });
  return {
    debug: (s, m, f) => emit('debug', s, m, merge(f)),
    info: (s, m, f) => emit('info', s, m, merge(f)),
    warn: (s, m, f) => emit('warn', s, m, merge(f)),
    error: (s, m, f) => emit('error', s, m, merge(f)),
    child: (baseFields) => make(merge(baseFields)),
  };
}

export const logger: Logger = make();
