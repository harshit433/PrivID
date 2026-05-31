import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '../api/public');

// Bundle React + Amplify + FaceLivenessDetector into ONE self-contained file so
// the mobile WebView loads a single same-origin asset instead of a fragile CDN
// module waterfall. Output is committed and served by the API at /liveness/.
await build({
  entryPoints: [resolve(__dirname, 'src/main.jsx')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020', 'chrome90', 'safari14'],
  minify: true,
  sourcemap: false,
  outfile: resolve(outDir, 'liveness.bundle.js'),
  loader: { '.js': 'jsx' },
  inject: [resolve(__dirname, 'shims/inject.js')],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  logLevel: 'info',
});

console.log('Liveness bundle written to', outDir);
