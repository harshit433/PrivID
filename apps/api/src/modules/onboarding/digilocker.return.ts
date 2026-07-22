/**
 * Public HTTPS landing Setu DigiLocker redirects to after consent.
 * Same-origin fallback so the mobile WebView can detect completion.
 */
import { Router, type Request, type Response } from 'express';

export const digilockerReturnRouter = Router();

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

digilockerReturnRouter.get('/return', (req: Request, res: Response) => {
  const successRaw = String(req.query.success ?? '').toLowerCase();
  const ok = successRaw === 'true' || successRaw === '1';
  const failed = successRaw === 'false' || successRaw === '0';
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  const errCode = typeof req.query.errCode === 'string' ? req.query.errCode : '';
  const errMessage = typeof req.query.errMessage === 'string' ? req.query.errMessage : '';
  const succeeded = ok || (!failed && !!id);

  const title = failed
    ? "Verification didn't finish"
    : succeeded
    ? 'Verification complete'
    : 'Finishing verification…';
  const body = failed
    ? errMessage ||
      'DigiLocker consent was cancelled or failed. Go back to TrustRoute and try again.'
    : succeeded
    ? 'Return to TrustRoute to finish setup. You can close this window.'
    : "Return to TrustRoute — we're confirming your DigiLocker consent.";
  const deep =
    `trustroute://digilocker/done?success=${encodeURIComponent(failed ? 'false' : 'true')}` +
    (id ? `&id=${encodeURIComponent(id)}` : '');

  const successActions = succeeded
    ? `<p style="margin-top:1rem;font-size:13px;color:#16a34a">Switch back to TrustRoute — verification is finishing automatically.</p>`
    : `<a href="${escapeHtml(deep)}">Open TrustRoute</a>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex"/>
<title>DigiLocker — TrustRoute</title>
<style>
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    background:#f6f7fa;color:#111827;display:flex;align-items:center;justify-content:center;
    min-height:100vh;padding:24px;text-align:center}
  .card{max-width:380px}
  .brand{font-weight:900;color:#16a34a;font-size:1.2rem;margin-bottom:1.5rem}
  h1{font-size:1.4rem;font-weight:900;margin:0 0 .6rem}
  p{color:#6b7280;font-weight:600;line-height:1.45;margin:0 0 1.25rem}
  a{display:block;background:#16a34a;color:#fff;text-decoration:none;font-weight:800;
    padding:.9rem 1rem;border-radius:14px}
  .fail a{background:#111827}
</style>
</head>
<body class="${failed ? 'fail' : ''}">
  <div class="card">
    <div class="brand">TrustRoute</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(body)}</p>
    ${successActions}
  </div>
  <script>
    (function(){
      var payload={type:'digilocker_callback',success:${failed ? 'false' : 'true'},id:${JSON.stringify(id || null)},errCode:${JSON.stringify(errCode || null)},errMessage:${JSON.stringify(errMessage || null)}};
      try{if(window.ReactNativeWebView&&window.ReactNativeWebView.postMessage){window.ReactNativeWebView.postMessage(JSON.stringify(payload));}}catch(e){}
    })();
  </script>
</body>
</html>`);
});

/** Alias paths the mobile WebView may hit. */
digilockerReturnRouter.get('/callback', (req, res) => {
  res.redirect(302, `/onboarding/digilocker/return?${new URLSearchParams(req.query as Record<string, string>).toString()}`);
});
