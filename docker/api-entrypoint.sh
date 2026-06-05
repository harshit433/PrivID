#!/bin/sh
set -e

export LD_LIBRARY_PATH="${THREEDIVI_SDK_PATH}/lib:${LD_LIBRARY_PATH:-}"

echo "[entrypoint] Waiting for Postgres..."
until node -e "
const { Client } = require('pg');
const c = new Client({ connectionString: process.env.DATABASE_URL });
c.connect().then(() => c.end()).then(() => process.exit(0)).catch(() => process.exit(1));
" 2>/dev/null; do
  sleep 2
done

echo "[entrypoint] Waiting for Redis..."
until node -e "
const Redis = require('ioredis');
const url = process.env.REDIS_PRIVATE_URL || process.env.REDIS_URL || 'redis://localhost:6379';
const r = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 5000, lazyConnect: true });
r.connect().then(() => r.ping()).then(() => { r.quit(); process.exit(0); }).catch(() => process.exit(1));
" 2>/dev/null; do
  sleep 2
done

echo "[entrypoint] Running migrations..."
cd /app && npm run db:migrate

if [ -d "${THREEDIVI_SDK_PATH}/lib" ] && [ -d "${THREEDIVI_SDK_PATH}/license" ]; then
  echo "[entrypoint] 3DiVi SDK mounted at ${THREEDIVI_SDK_PATH} ($(uname -m))"
  ls "${THREEDIVI_SDK_PATH}/lib" 2>/dev/null | head -3 || true
  if [ -d "${THREEDIVI_SDK_PATH}/python_api" ]; then
    echo "[entrypoint] Installing face_sdk_3divi Python package..."
    pip3 install -q "${THREEDIVI_SDK_PATH}/python_api" --break-system-packages 2>/dev/null \
      || pip3 install -q "${THREEDIVI_SDK_PATH}/python_api" 2>/dev/null \
      || true
  fi
  if [ -f "${THREEDIVI_SDK_PATH}/node_js_api/prebuilds/linux-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')/face_sdk_3divi.node" ] 2>/dev/null; then
    echo "[entrypoint] Liveness runner: node (native prebuild found)"
  else
    echo "[entrypoint] Liveness runner: python (arm64 SDK / no matching node prebuild)"
    export THREEDIVI_RUNNER=python
  fi
else
  echo "[entrypoint] WARN: 3DiVi SDK not found at ${THREEDIVI_SDK_PATH} — liveness will auto-pass (dev mode)"
fi

cd /app/api
if [ "$#" -gt 0 ]; then
  echo "[entrypoint] Running provided command: $*"
  exec "$@"
fi

echo "[entrypoint] Starting API on port ${API_PORT:-3000}..."
exec node dist/server.js
