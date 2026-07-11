import http from 'http';
import https from 'https';
import { URL } from 'url';

const PORT = Number(process.env.PORT || 8080);
const UPSTREAM = (process.env.SETU_UPSTREAM || 'https://dg-sandbox.setu.co').replace(/\/$/, '');
const SHARED_SECRET = process.env.PROXY_SHARED_SECRET || '';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function forward(method, path, headers, body) {
  const target = new URL(path, `${UPSTREAM}/`);
  const payload = body?.length ? body : undefined;
  const opts = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || 443,
    path: `${target.pathname}${target.search}`,
    method,
    headers: {
      accept: headers.accept || 'application/json',
      'content-type': headers['content-type'] || 'application/json',
      'x-client-id': headers['x-client-id'],
      'x-client-secret': headers['x-client-secret'],
      'x-product-instance-id': headers['x-product-instance-id'],
      ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
    },
  };
  return new Promise((resolve, reject) => {
    const lib = target.protocol === 'http:' ? http : https;
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode || 502,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'setu-proxy', upstream: UPSTREAM }));
      return;
    }
    if (SHARED_SECRET) {
      const got = req.headers['x-proxy-secret'];
      if (got !== SHARED_SECRET) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        return;
      }
    }
    if (!req.url?.startsWith('/api/digilocker')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not_found' }));
      return;
    }
    const body = await readBody(req);
    const out = await forward(req.method || 'GET', req.url, req.headers, body);
    res.writeHead(out.status, { 'content-type': out.headers['content-type'] || 'application/json' });
    res.end(out.body);
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[setu-proxy] listening on :${PORT} → ${UPSTREAM}`);
});
