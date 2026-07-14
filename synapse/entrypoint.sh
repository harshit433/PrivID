#!/bin/sh
# Generate Synapse homeserver.yaml from Railway/env and start Synapse.
set -eu

DATA="${SYNAPSE_DATA_DIR:-/data}"
CONFIG="${SYNAPSE_CONFIG_PATH:-$DATA/homeserver.yaml}"
LOG_CONFIG="${SYNAPSE_LOG_CONFIG:-$DATA/log.config}"
PORT="${PORT:-8008}"

mkdir -p "$DATA/media_store" "$DATA/uploads"

# Prefer explicit Synapse DB URL; otherwise adapt MAIN Postgres URL to dbname=synapse.
if [ -z "${SYNAPSE_DATABASE_URL:-}" ]; then
  if [ -n "${DATABASE_URL:-}" ]; then
    SYNAPSE_DATABASE_URL=$(printf '%s' "$DATABASE_URL" | sed -E 's#/(railway|privid|postgres)(\?|$)#/synapse\2#')
  else
    echo "[synapse] SYNAPSE_DATABASE_URL or DATABASE_URL is required" >&2
    exit 1
  fi
fi

# Parse postgresql://user:pass@host:port/db — may contain special chars in password.
eval "$(python3 - <<'PY'
import os, urllib.parse, shlex
url = os.environ.get("SYNAPSE_DATABASE_URL") or os.environ["DATABASE_URL"]
# Rewrite path if still not synapse
u = urllib.parse.urlparse(url)
path = u.path or "/synapse"
if path in ("/", "/railway", "/privid", "/postgres", ""):
    path = "/synapse"
    u = u._replace(path=path)
    url = urllib.parse.urlunparse(u)
os.environ["SYNAPSE_DATABASE_URL"] = url
u = urllib.parse.urlparse(url)
user = urllib.parse.unquote(u.username or "")
password = urllib.parse.unquote(u.password or "")
host = u.hostname or "localhost"
port = str(u.port or 5432)
dbname = (u.path or "/synapse").lstrip("/") or "synapse"
# Strip query from host for Synapse psycopg2
print(f"export SYNAPSE_DB_USER={shlex.quote(user)}")
print(f"export SYNAPSE_DB_PASSWORD={shlex.quote(password)}")
print(f"export SYNAPSE_DB_HOST={shlex.quote(host)}")
print(f"export SYNAPSE_DB_PORT={shlex.quote(port)}")
print(f"export SYNAPSE_DB_NAME={shlex.quote(dbname)}")
print(f"export SYNAPSE_DATABASE_URL={shlex.quote(url)}")
PY
)"

SERVER_NAME="${SYNAPSE_SERVER_NAME:-${MATRIX_SERVER_NAME:-matrix.trustroute.app}}"
PUBLIC_BASEURL="${SYNAPSE_PUBLIC_BASEURL:-}"
if [ -z "$PUBLIC_BASEURL" ]; then
  if [ -n "${RAILWAY_PUBLIC_DOMAIN:-}" ]; then
    PUBLIC_BASEURL="https://${RAILWAY_PUBLIC_DOMAIN}/"
  else
    PUBLIC_BASEURL="http://localhost:${PORT}/"
  fi
fi

JWT_SECRET="${MATRIX_JWT_SECRET:-${SYNAPSE_JWT_SECRET:-}}"
if [ -z "$JWT_SECRET" ]; then
  echo "[synapse] MATRIX_JWT_SECRET is required" >&2
  exit 1
fi
export JWT_SECRET_FOR_SEED="$JWT_SECRET"

MACAROON="${SYNAPSE_MACAROON_SECRET:-}"
FORM="${SYNAPSE_FORM_SECRET:-}"
REG="${SYNAPSE_REGISTRATION_SHARED_SECRET:-}"
if [ -z "$MACAROON" ] || [ -z "$FORM" ] || [ -z "$REG" ]; then
  SEED=$(python3 - <<PY
import hashlib, os
print(hashlib.sha256(os.environ["JWT_SECRET_FOR_SEED"].encode()).hexdigest())
PY
)
  MACAROON="${MACAROON:-mac_${SEED}}"
  FORM="${FORM:-form_${SEED}}"
  REG="${REG:-reg_${SEED}}"
fi

SIGNING_KEY="${DATA}/${SERVER_NAME}.signing.key"

# Log config
cat > "$LOG_CONFIG" <<EOF
version: 1
formatters:
  precise:
    format: '%(asctime)s - %(name)s - %(lineno)d - %(levelname)s - %(request)s - %(message)s'
handlers:
  console:
    class: logging.StreamHandler
    formatter: precise
loggers:
  synapse.storage.SQL:
    level: WARN
root:
  level: INFO
  handlers: [console]
disable_existing_loggers: false
EOF

# Homeserver config (JWT login + private HS, no federation / open registration)
cat > "$CONFIG" <<EOF
server_name: "${SERVER_NAME}"
pid_file: ${DATA}/homeserver.pid
public_baseurl: "${PUBLIC_BASEURL}"
web_client_location: null

listeners:
  - port: ${PORT}
    tls: false
    type: http
    x_forwarded: true
    bind_addresses: ['::']
    resources:
      - names: [client, federation]
        compress: false

database:
  name: psycopg2
  allow_unsafe_locale: true
  args:
    user: "${SYNAPSE_DB_USER}"
    password: "${SYNAPSE_DB_PASSWORD}"
    dbname: "${SYNAPSE_DB_NAME}"
    host: "${SYNAPSE_DB_HOST}"
    port: ${SYNAPSE_DB_PORT}
    cp_min: 2
    cp_max: 10
    keepalives_idle: 10
    keepalives_interval: 10
    keepalives_count: 3
    sslmode: prefer

log_config: "${LOG_CONFIG}"
media_store_path: ${DATA}/media_store
uploads_path: ${DATA}/uploads
max_upload_size: ${MAX_UPLOAD_SIZE:-50M}

enable_registration: false
enable_registration_without_verification: false
allow_guest_access: false

federation_domain_whitelist: []
allow_public_rooms_over_federation: false
allow_public_rooms_without_auth: false

jwt_config:
  enabled: true
  secret: "${JWT_SECRET}"
  algorithm: "HS256"
  subject_claim: "sub"

rc_message:
  per_second: 2.0
  burst_count: 20

rc_login:
  address:
    per_second: 0.5
    burst_count: 5
  account:
    per_second: 0.2
    burst_count: 3

suppress_key_server_warning: true
report_stats: false

macaroon_secret_key: "${MACAROON}"
form_secret: "${FORM}"
signing_key_path: "${SIGNING_KEY}"
trusted_key_servers: []
registration_shared_secret: "${REG}"

experimental_features:
  msc2285_enabled: true
EOF

export SYNAPSE_CONFIG_PATH="$CONFIG"
export SYNAPSE_SERVER_NAME="$SERVER_NAME"

if [ ! -f "$SIGNING_KEY" ]; then
  echo "[synapse] Generating signing key..."
  python -m synapse.app.homeserver --config-path "$CONFIG" --generate-keys
fi

echo "[synapse] Starting homeserver ${SERVER_NAME} on :${PORT} (public_baseurl=${PUBLIC_BASEURL})"
exec python -m synapse.app.homeserver --config-path "$CONFIG"
