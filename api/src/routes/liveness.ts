import { Router, Request, Response } from 'express';
import { isLivenessConfigured } from '../services/liveness';

export const livenessRouter = Router();

// ─── GET /liveness/web ──────────────────────────────────────────────────────────
// Lightweight selfie-capture page loaded inside react-native-webview during
// onboarding. It opens the front camera, guides the user to centre their face,
// auto-captures a single frame (no buttons), and posts the JPEG back to the
// React Native host. The host uploads it to /trust/verify/liveness/complete,
// which runs passive liveness via the managed provider. No on-device model, no
// streaming, no CDN — the page is tiny and loads instantly.
livenessRouter.get('/web', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (!isLivenessConfigured()) {
    res.send(notConfiguredPage());
    return;
  }
  res.send(capturePage());
});

function notConfiguredPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
<style>body{margin:0;background:#05060F;color:#fff;font-family:-apple-system,Roboto,sans-serif;
display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;padding:24px}</style>
</head><body><div>
<h3>Liveness not available</h3>
<p style="color:#9aa0b4">Liveness is not set up on the server.</p>
</div>
<script>setTimeout(function(){if(window.ReactNativeWebView){window.ReactNativeWebView.postMessage(JSON.stringify({type:'error',message:'LIVENESS_NOT_CONFIGURED'}))}},300)</script>
</body></html>`;
}

function capturePage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<title>Liveness check</title>
<style>
  :root { --accent: #7C5CF6; }
  html, body { height: 100%; margin: 0; }
  body { background: #05060F; color: #fff; font-family: -apple-system, Roboto, sans-serif; overflow: hidden; }
  #wrap { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .stage { position: relative; width: 78vw; max-width: 320px; aspect-ratio: 3/4; border-radius: 24px; overflow: hidden; background: #0b0d18; box-shadow: 0 10px 40px rgba(0,0,0,0.5); }
  video { width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); background: #0b0d18; }
  .oval { position: absolute; inset: 0; pointer-events: none; }
  .oval::after { content: ''; position: absolute; left: 50%; top: 47%; width: 58%; height: 70%; transform: translate(-50%,-50%); border: 3px solid rgba(255,255,255,0.85); border-radius: 50%; box-shadow: 0 0 0 1000px rgba(5,6,15,0.55); }
  .ring { position: absolute; left: 50%; top: 47%; width: 58%; height: 70%; transform: translate(-50%,-50%); }
  .ring circle { fill: none; stroke: var(--accent); stroke-width: 4; stroke-linecap: round; transform: rotate(-90deg); transform-origin: 50% 50%; transition: stroke-dashoffset 0.1s linear; }
  #status { margin-top: 22px; font-size: 15px; color: #cdd2e4; text-align: center; padding: 0 28px; line-height: 1.4; min-height: 40px; }
  #count { position: absolute; left: 50%; top: 47%; transform: translate(-50%,-50%); font-size: 56px; font-weight: 800; color: #fff; text-shadow: 0 2px 12px rgba(0,0,0,0.6); }
  .flash { position: absolute; inset: 0; background: #fff; opacity: 0; transition: opacity 0.15s; }
  .flash.on { opacity: 0.85; }
</style>
</head>
<body>
<div id="wrap">
  <div class="stage">
    <video id="v" autoplay playsinline muted></video>
    <div class="oval"></div>
    <svg class="ring" viewBox="0 0 100 100"><circle id="prog" cx="50" cy="50" r="46" stroke-dasharray="289" stroke-dashoffset="289"></circle></svg>
    <div id="count"></div>
    <div class="flash" id="flash"></div>
  </div>
  <div id="status">Starting camera…</div>
</div>
<canvas id="c" style="display:none"></canvas>
<script>
  function post(msg){ try { window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(msg)); } catch(e){} }
  function setStatus(t){ var s=document.getElementById('status'); if(s) s.textContent=t; }
  var video=document.getElementById('v');
  var prog=document.getElementById('prog');
  var countEl=document.getElementById('count');
  var DASH=289, HOLD_MS=2600, captured=false, started=false;

  window.addEventListener('error', function(e){ setStatus('Error: '+(e&&e.message?e.message:'unknown')); });

  function capture(){
    if(captured) return; captured=true;
    try {
      var c=document.getElementById('c');
      var w=video.videoWidth||480, h=video.videoHeight||640;
      // cap to keep upload small/fast
      var scale=Math.min(1, 720/Math.max(w,h));
      c.width=Math.round(w*scale); c.height=Math.round(h*scale);
      var ctx=c.getContext('2d');
      ctx.drawImage(video,0,0,c.width,c.height);
      var data=c.toDataURL('image/jpeg',0.85);
      var fl=document.getElementById('flash'); fl.classList.add('on'); setTimeout(function(){fl.classList.remove('on');},180);
      setStatus('Got it — verifying…');
      try { (video.srcObject?video.srcObject.getTracks():[]).forEach(function(t){t.stop();}); } catch(e){}
      post({ type:'capture', image:data });
    } catch(err){ post({ type:'error', message:'CAPTURE_FAILED: '+(err&&err.message?err.message:String(err)) }); }
  }

  function runCountdown(){
    setStatus('Hold still and look at the camera');
    var start=Date.now();
    var iv=setInterval(function(){
      var el=Date.now()-start, p=Math.min(1, el/HOLD_MS);
      prog.style.strokeDashoffset=String(DASH*(1-p));
      var remain=Math.ceil((HOLD_MS-el)/1000);
      countEl.textContent = remain>0 ? String(remain) : '';
      if(p>=1){ clearInterval(iv); countEl.textContent=''; capture(); }
    },80);
  }

  function beginWhenReady(){
    if(started) return; started=true;
    setTimeout(runCountdown, 500);
  }

  (async function(){
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      setStatus('Camera API unavailable on this device/WebView.');
      post({ type:'error', message:'NO_MEDIA_DEVICES' });
      return;
    }
    setStatus('Starting camera…');

    // Watchdog: if the camera neither starts nor errors (permission prompt never
    // answered by the WebView), surface it instead of hanging forever.
    var watchdog=setTimeout(function(){
      if(!started){
        setStatus('Camera did not start. Check camera permission for the app and retry.');
        post({ type:'error', message:'CAMERA_TIMEOUT' });
      }
    }, 9000);

    // Start the countdown as soon as frames are flowing (more reliable than
    // onloadedmetadata across Android WebViews).
    video.oncanplay=function(){ clearTimeout(watchdog); beginWhenReady(); };
    video.onplaying=function(){ clearTimeout(watchdog); beginWhenReady(); };

    function tryGet(constraints){ return navigator.mediaDevices.getUserMedia(constraints); }

    try {
      var stream;
      try { stream=await tryGet({ video:{ facingMode:'user' }, audio:false }); }
      catch(e1){ stream=await tryGet({ video:true, audio:false }); }
      video.srcObject=stream;
      try { await video.play(); } catch(e){ /* autoplay may defer; canplay handles it */ }
      // Safety: if events somehow don't fire but we have a stream, start anyway.
      setTimeout(function(){ if(!started && video.srcObject){ clearTimeout(watchdog); beginWhenReady(); } }, 2500);
    } catch(camErr){
      clearTimeout(watchdog);
      var name=camErr&&camErr.name?camErr.name:String(camErr);
      setStatus('Camera blocked: '+name+'. Allow camera access and retry.');
      post({ type:'error', message:'CAMERA_DENIED: '+name });
    }
  })();
</script>
</body>
</html>`;
}
