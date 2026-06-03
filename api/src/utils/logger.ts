/**
 * api/src/utils/logger.ts
 *
 * Structured logger for the API service.
 *
 * In production: emits newline-delimited JSON to stdout/stderr so log
 * aggregators (Datadog, Loki, CloudWatch, Railway) can parse fields without
 * regex fragility.
 *
 * In development: falls back to human-readable console output so local
 * terminals stay readable.
 *
 * Shape of each JSON line:
 *   { ts, level, svc, tag, msg, ...meta }
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type Meta = Record<string, unknown>;

const isProd = process.env.NODE_ENV === 'production';

function emit(level: LogLevel, tag: string, msg: string, meta?: Meta): void {
  if (isProd) {
    const line = JSON.stringify({
      ts:  new Date().toISOString(),
      level,
      svc: 'api',
      tag,
      msg,
      ...(meta ?? {}),
    });
    if (level === 'error' || level === 'warn') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  } else {
    // Human-readable dev output
    const ts     = new Date().toISOString().slice(11, 23); // HH:mm:ss.mmm
    const prefix = `${ts} [${level.toUpperCase().padEnd(5)}] [${tag}]`;
    const detail = meta ? ' ' + JSON.stringify(meta) : '';
    const line   = `${prefix} ${msg}${detail}`;

    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else if (level === 'debug') {
      console.debug(line);
    } else {
      console.log(line);
    }
  }
}

export const logger = {
  /**
   * debug — emitted in development only.
   * Use for noisy diagnostic lines that would flood production logs.
   */
  debug(tag: string, msg: string, meta?: Meta): void {
    if (!isProd) emit('debug', tag, msg, meta);
  },

  info(tag: string, msg: string, meta?: Meta): void {
    emit('info', tag, msg, meta);
  },

  warn(tag: string, msg: string, meta?: Meta): void {
    emit('warn', tag, msg, meta);
  },

  error(tag: string, msg: string, meta?: Meta): void {
    emit('error', tag, msg, meta);
  },
};
