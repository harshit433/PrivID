/** Dev-only structured logging — no output when NODE_ENV is production. */

const isDev = process.env.NODE_ENV !== 'production';

export const logger = {
  debug(_tag: string, ...args: unknown[]): void {
    if (isDev) {
      // eslint-disable-next-line no-console
      console.log(...args);
    }
  },
  warn(tag: string, ...args: unknown[]): void {
    if (isDev) {
      // eslint-disable-next-line no-console
      console.warn(`[${tag}]`, ...args);
    }
  },
  error(tag: string, ...args: unknown[]): void {
    if (isDev) {
      // eslint-disable-next-line no-console
      console.error(`[${tag}]`, ...args);
    }
  },
};
