import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { livenessRegion, livenessIdentityPoolId, isLivenessConfigured } from '../services/rekognition';

export const livenessRouter = Router();

// ─── Static bundle location ──────────────────────────────────────────────────
// The Face Liveness web app (React + Amplify + FaceLivenessDetector) is
// pre-bundled into a single self-contained file by ../../../liveness-web and
// committed to api/public. Serving one same-origin asset is far more reliable
// inside a mobile WebView than loading the heavy Amplify SDK from a CDN at
// runtime (that module waterfall stalls on real devices).
function publicDir(): string {
  const candidates = [
    path.join(__dirname, '../../public'), // dist/routes -> api/public  (and src/routes -> api/public via tsx)
    path.join(process.cwd(), 'public'),
    path.join(process.cwd(), 'api/public'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'liveness.bundle.js'))) return dir;
  }
  return candidates[0];
}

function bundleVersion(): string {
  try {
    const stat = fs.statSync(path.join(publicDir(), 'liveness.bundle.js'));
    return String(Math.floor(stat.mtimeMs));
  } catch {
    return '0';
  }
}

// Serve the bundle + styles. Long-cache (immutable) — the HTML shell appends a
// ?v=<mtime> cache-buster so a new deploy is always picked up.
livenessRouter.get('/liveness.bundle.js', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(path.join(publicDir(), 'liveness.bundle.js'));
});

livenessRouter.get('/liveness.bundle.css', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/css; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(path.join(publicDir(), 'liveness.bundle.css'));
});

// ─── GET /liveness/web ──────────────────────────────────────────────────────────
// HTML shell loaded inside react-native-webview during onboarding. It injects
// the session config and loads the local bundle, which opens the camera, runs
// the Amazon Rekognition Face Liveness challenge and posts the outcome back to
// the React Native host via window.ReactNativeWebView.
//
// Query params:
//   sessionId — the Rekognition SessionId from CreateFaceLivenessSession
//   region    — (optional) overrides the server default region
livenessRouter.get('/web', (req: Request, res: Response) => {
  const sessionId = String(req.query.sessionId ?? '').trim();
  const region = String(req.query.region ?? '').trim() || livenessRegion();
  const identityPoolId = livenessIdentityPoolId() ?? '';

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  const bundleExists = fs.existsSync(path.join(publicDir(), 'liveness.bundle.js'));
  if (!isLivenessConfigured() || !identityPoolId || !bundleExists) {
    res.send(notConfiguredPage(!bundleExists ? 'BUNDLE_MISSING' : 'LIVENESS_NOT_CONFIGURED'));
    return;
  }

  res.send(livenessPage({ sessionId, region, identityPoolId, v: bundleVersion() }));
});

function notConfiguredPage(reason: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
<style>body{margin:0;background:#05060F;color:#fff;font-family:-apple-system,Roboto,sans-serif;
display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;padding:24px}</style>
</head><body><div>
<h3>Liveness not available</h3>
<p style="color:#9aa0b4">Face Liveness is not set up on the server.</p>
</div>
<script>setTimeout(function(){if(window.ReactNativeWebView){window.ReactNativeWebView.postMessage(JSON.stringify({type:'error',message:'${reason}'}))}},300)</script>
</body></html>`;
}

function livenessPage(cfg: { sessionId: string; region: string; identityPoolId: string; v: string }): string {
  const data = JSON.stringify({ sessionId: cfg.sessionId, region: cfg.region, identityPoolId: cfg.identityPoolId });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<title>Liveness check</title>
<link rel="stylesheet" href="/liveness/liveness.bundle.css?v=${cfg.v}" />
<style>
  html, body, #root { height: 100%; margin: 0; }
  body { background: #05060F; color: #fff; font-family: -apple-system, Roboto, sans-serif; overflow: hidden; }
  #loading { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; }
  .spinner { width: 36px; height: 36px; border: 3px solid rgba(255,255,255,0.2); border-top-color: #7C5CF6; border-radius: 50%; animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  [data-amplify-liveness-detector] { --amplify-colors-background-primary: #05060F; }
</style>
</head>
<body>
<div id="root"><div id="loading"><div class="spinner"></div><div id="status" style="color:#9aa0b4;text-align:center;padding:0 24px;line-height:1.4">Preparing camera…</div></div></div>
<script>window.__PRIVID_LIVENESS__ = ${data};</script>
<script src="/liveness/liveness.bundle.js?v=${cfg.v}"></script>
</body>
</html>`;
}
