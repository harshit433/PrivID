#!/usr/bin/env bash
# Generate Synapse config from template using env secrets.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="$ROOT/homeserver.yaml.template"
OUT="${SYNAPSE_CONFIG_OUT:-$ROOT/data/homeserver.yaml}"
mkdir -p "$(dirname "$OUT")" "$ROOT/data/media_store" "$ROOT/data/uploads"

JWT_SECRET="${MATRIX_JWT_SECRET:-dev_matrix_jwt_secret_change_me}"
MACAROON="${MATRIX_MACAROON_SECRET:-dev_macaroon_secret_change_me_32}"
FORM="${MATRIX_FORM_SECRET:-dev_form_secret_change_me_32_____}"
REG="${MATRIX_REGISTRATION_SHARED_SECRET:-dev_registration_shared_secret}"
SERVER_NAME="${MATRIX_SERVER_NAME:-trustroute.local}"
PUBLIC_BASE="${MATRIX_PUBLIC_BASEURL:-http://localhost:8008/}"

sed \
  -e "s|CHANGE_ME_MATRIX_JWT_SECRET|${JWT_SECRET}|g" \
  -e "s|CHANGE_ME_MACAROON_SECRET_KEY_32chars|${MACAROON}|g" \
  -e "s|CHANGE_ME_FORM_SECRET_KEY_32chars____|${FORM}|g" \
  -e "s|CHANGE_ME_REGISTRATION_SHARED_SECRET|${REG}|g" \
  -e "s|server_name: \"trustroute.local\"|server_name: \"${SERVER_NAME}\"|g" \
  -e "s|public_baseurl: \"http://localhost:8008/\"|public_baseurl: \"${PUBLIC_BASE}\"|g" \
  "$TEMPLATE" > "$OUT"

cp "$ROOT/log.config" "$ROOT/data/log.config"
echo "Wrote $OUT"
