import React from 'react';
import { createRoot } from 'react-dom/client';
import { Amplify } from 'aws-amplify';
import { FaceLivenessDetector } from '@aws-amplify/ui-react-liveness';
import '@aws-amplify/ui-react/styles.css';

// Config is injected by the server-rendered HTML shell before this bundle runs.
const CFG = window.__PRIVID_LIVENESS__ || {};

function post(msg) {
  try {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(msg));
    }
  } catch (e) {
    /* noop */
  }
}

function setStatus(text) {
  const s = document.getElementById('status');
  if (s) s.textContent = text;
}

window.addEventListener('error', (e) => {
  const m = e && e.message ? e.message : 'unknown';
  setStatus('Script error: ' + m);
  post({ type: 'error', message: 'WINDOW_ERROR: ' + m });
});

function App() {
  return React.createElement(FaceLivenessDetector, {
    sessionId: CFG.sessionId,
    region: CFG.region,
    disableStartScreen: true,
    onAnalysisComplete: async () => {
      post({ type: 'complete' });
    },
    onError: (error) => {
      const detail =
        (error && (error.state || (error.error && error.error.message) || error.message)) ||
        JSON.stringify(error);
      setStatus('Detector error: ' + detail);
      post({ type: 'error', message: 'DETECTOR: ' + detail });
    },
    onUserCancel: () => {
      post({ type: 'cancel' });
    },
  });
}

(async () => {
  try {
    setStatus('Requesting camera…');
    // Explicit getUserMedia so a blocked camera fails loudly instead of hanging.
    try {
      const test = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
      test.getTracks().forEach((t) => t.stop());
    } catch (camErr) {
      const name = camErr && camErr.name ? camErr.name : String(camErr);
      setStatus('Camera blocked: ' + name + '. Allow camera access and retry.');
      post({ type: 'error', message: 'CAMERA_DENIED: ' + name });
      return;
    }

    Amplify.configure({
      Auth: { Cognito: { identityPoolId: CFG.identityPoolId, allowGuestAccess: true } },
    });

    const loading = document.getElementById('loading');
    if (loading) loading.remove();
    createRoot(document.getElementById('root')).render(React.createElement(App));
  } catch (err) {
    const m = err && err.message ? err.message : String(err);
    setStatus('Failed to start: ' + m);
    post({ type: 'error', message: 'LOAD_FAILED: ' + m });
  }
})();
