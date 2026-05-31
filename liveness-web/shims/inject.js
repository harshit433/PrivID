// Browser polyfills for the few Node globals that aws-amplify's Face Liveness
// streaming path still references (Buffer for binary video chunks, process.env,
// and `global`). These are injected into the bundle by esbuild (see build.mjs)
// so the page runs inside a mobile WebView with no Node runtime.
import { Buffer as _Buffer } from 'buffer';

if (typeof globalThis.global === 'undefined') globalThis.global = globalThis;
if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = _Buffer;
if (typeof globalThis.process === 'undefined') {
  globalThis.process = {
    env: { NODE_ENV: 'production' },
    browser: true,
    version: '',
    nextTick: (cb, ...args) => Promise.resolve().then(() => cb(...args)),
  };
}

export const Buffer = _Buffer;
export const process = globalThis.process;
export const global = globalThis;
