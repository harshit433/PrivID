#!/bin/sh
set -e

echo "[entrypoint] Waiting for Postgres..."
until node -e "
const { Client } = require('pg');
const c = new Client({ connectionString: process.env.DATABASE_URL });
c.connect().then(() => c.end()).then(() => process.exit(0)).catch(() => process.exit(1));
" 2>/dev/null; do
  sleep 2
done

echo "[entrypoint] Waiting for Redis..."
REDIS_ATTEMPTS=0
until node -e "
const Redis = require('ioredis');
const url = process.env.REDIS_PRIVATE_URL || process.env.REDIS_URL || 'redis://localhost:6379';
const r = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 5000, lazyConnect: true });
r.connect().then(() => r.ping()).then(() => { r.quit(); process.exit(0); }).catch(() => process.exit(1));
" 2>/dev/null; do
  REDIS_ATTEMPTS=$((REDIS_ATTEMPTS + 1))
  if [ "$REDIS_ATTEMPTS" -ge 30 ]; then
    echo "[entrypoint] WARN: Redis not ready after 30 attempts — starting without it (rate limits may fail)"
    break
  fi
  sleep 2
done

echo "[entrypoint] Running migrations..."
cd /app && npm run db:migrate

cd /app/api
if [ "$#" -gt 0 ]; then
  echo "[entrypoint] Running provided command: $*"
  exec "$@"
fi

echo "[entrypoint] Starting API on port ${API_PORT:-3000}..."
if [ -f "dist/server.js" ]; then
  exec node dist/server.js
fi

# Fallback for workspace/tsconfig path layouts seen in some builds.
if [ -f "dist/api/src/server.js" ]; then
  exec node dist/api/src/server.js
fi

echo "[entrypoint] ERROR: build output missing. Expected dist/server.js (or dist/api/src/server.js)."
echo "[entrypoint] Ensure Docker image runs 'npm run build' for @trustroute/api before startup."
exit 1
