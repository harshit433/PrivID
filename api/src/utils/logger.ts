/** Structured server logging — debug is dev-only; info/warn/error always emit. */

const isDev = process.env.NODE_ENV !== 'production';

export const logger = {
  debug(tag: string, ...args: unknown[]): void {
    if (isDev) {
      // eslint-disable-next-line no-console
      console.log(`[${tag}]`, ...args);
    }
  },
  info(tag: string, ...args: unknown[]): void {
    // eslint-disable-next-line no-console
    console.log(`[${tag}]`, ...args);
  },
  warn(tag: string, ...args: unknown[]): void {
    // eslint-disable-next-line no-console
    console.warn(`[${tag}]`, ...args);
  },
  error(tag: string, ...args: unknown[]): void {
    // eslint-disable-next-line no-console
    console.error(`[${tag}]`, ...args);
  },
};
