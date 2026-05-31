import { Router, Request, Response } from 'express';
import { livenessRegion, livenessIdentityPoolId, isLivenessConfigured } from '../services/rekognition';

export const livenessRouter = Router();

// ─── GET /liveness/web ──────────────────────────────────────────────────────────
// Self-contained page that renders the official AWS Amplify FaceLivenessDetector.
// It is loaded inside a react-native-webview during onboarding. The component
// opens the camera, shows the oval + challenge instructions, records a short
// selfie video and streams it straight to Amazon Rekognition (using temporary
// credentials from the Cognito identity pool). When analysis finishes it posts
// the outcome back to the React Native host via window.ReactNativeWebView.
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

  if (!isLivenessConfigured() || !identityPoolId) {
    res.send(notConfiguredPage());
    return;
  }

  res.send(livenessPage({ sessionId, region, identityPoolId }));
});

function notConfiguredPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
<style>body{margin:0;background:#05060F;color:#fff;font-family:-apple-system,Roboto,sans-serif;
display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;padding:24px}</style>
</head><body><div>
<h3>Liveness not configured</h3>
<p style="color:#9aa0b4">Amazon Rekognition Face Liveness is not set up on the server.</p>
</div>
<script>setTimeout(function(){if(window.ReactNativeWebView){window.ReactNativeWebView.postMessage(JSON.stringify({type:'error',message:'LIVENESS_NOT_CONFIGURED'}))}},300)</script>
</body></html>`;
}

function livenessPage(cfg: { sessionId: string; region: string; identityPoolId: string }): string {
  const data = JSON.stringify(cfg);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<title>Liveness check</title>
<link rel="stylesheet" href="https://esm.sh/@aws-amplify/ui-react@6/styles.css" />
<style>
  html, body, #root { height: 100%; margin: 0; }
  body { background: #05060F; color: #fff; font-family: -apple-system, Roboto, sans-serif; overflow: hidden; }
  #loading { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; }
  .spinner { width: 36px; height: 36px; border: 3px solid rgba(255,255,255,0.2); border-top-color: #7C5CF6; border-radius: 50%; animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  /* Tint the Amplify detector to the PrivID dark theme */
  [data-amplify-liveness-detector] { --amplify-colors-background-primary: #05060F; }
</style>
</head>
<body>
<div id="root"><div id="loading"><div class="spinner"></div><div style="color:#9aa0b4">Preparing camera…</div></div></div>
<script type="module">
  const CFG = ${data};
  function post(msg) {
    try { window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(msg)); } catch (e) {}
  }
  (async () => {
    try {
      const React = (await import('https://esm.sh/react@18')).default;
      const { createRoot } = await import('https://esm.sh/react-dom@18/client');
      const { Amplify } = await import('https://esm.sh/aws-amplify@6');
      const liveness = await import('https://esm.sh/@aws-amplify/ui-react-liveness@3?bundle&deps=aws-amplify@6,react@18,react-dom@18,@aws-amplify/ui-react@6');
      const FaceLivenessDetector = liveness.FaceLivenessDetector;

      Amplify.configure({
        Auth: { Cognito: { identityPoolId: CFG.identityPoolId, allowGuestAccess: true } },
      });

      function App() {
        return React.createElement(FaceLivenessDetector, {
          sessionId: CFG.sessionId,
          region: CFG.region,
          disableStartScreen: true,
          onAnalysisComplete: async () => { post({ type: 'complete' }); },
          onError: (error) => { post({ type: 'error', message: (error && error.state) || String(error) }); },
          onUserCancel: () => { post({ type: 'cancel' }); },
        });
      }

      const el = document.getElementById('loading');
      if (el) el.remove();
      createRoot(document.getElementById('root')).render(React.createElement(App));
    } catch (err) {
      post({ type: 'error', message: 'LOAD_FAILED: ' + (err && err.message ? err.message : String(err)) });
    }
  })();
</script>
</body>
</html>`;
}
