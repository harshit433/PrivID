export const logger = {
  debug: (tag: string, msg: string, extra?: unknown) => {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[${tag}]`, msg, extra ?? '');
    }
  },
  info: (tag: string, msg: string, extra?: unknown) => console.log(`[${tag}]`, msg, extra ?? ''),
  warn: (tag: string, msg: string, extra?: unknown) => console.warn(`[${tag}]`, msg, extra ?? ''),
  error: (tag: string, msg: string, extra?: unknown) => console.error(`[${tag}]`, msg, extra ?? ''),
};
