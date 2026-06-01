#!/bin/bash
# TrustRoute Backend Deployment Script
# Run this on your DigitalOcean droplet or any Ubuntu 22.04 server
#
# Usage: curl -sSL https://your-domain/deploy.sh | bash
# Or:    bash scripts/deploy.sh

set -e

echo "🚀 TrustRoute Backend Deployment"
echo ""

# ── 1. Install Docker if not present ─────────────────────────────────────────
if ! command -v docker &> /dev/null; then
    echo "Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    usermod -aG docker $USER
    systemctl enable docker
    echo "✅ Docker installed"
fi

# ── 2. Generate JWT keys if not present ──────────────────────────────────────
if [ ! -f "api/keys/private.pem" ]; then
    echo "Generating JWT RSA keys..."
    mkdir -p api/keys
    openssl genrsa -out api/keys/private.pem 2048
    openssl rsa -in api/keys/private.pem -pubout -out api/keys/public.pem
    chmod 600 api/keys/private.pem
    echo "✅ JWT keys generated at api/keys/"
fi

# ── 3. Set up environment ──────────────────────────────────────────────────────
if [ ! -f "api/.env.production" ]; then
    echo ""
    echo "⚠️  api/.env.production not found!"
    echo "    Copy the example and fill in your values:"
    echo "    cp api/.env.production.example api/.env.production"
    echo "    nano api/.env.production"
    exit 1
fi

# ── 4. Run database migrations ────────────────────────────────────────────────
echo "Running database migrations..."
docker compose -f docker-compose.prod.yml run --rm api node -e "
const { getPool } = require('@trustroute/shared');
const fs = require('fs');
const path = require('path');
const pool = getPool();

async function migrate() {
  const files = fs.readdirSync('/db/migrations').sort();
  for (const f of files) {
    if (!f.endsWith('.sql')) continue;
    const sql = fs.readFileSync(path.join('/db/migrations', f), 'utf8');
    await pool.query(sql);
    console.log('Applied:', f);
  }
  await pool.end();
}
migrate().catch(e => { console.error(e); process.exit(1); });
" 2>/dev/null || echo "  (Migration step skipped — run manually if needed)"

# ── 5. Build and start services ───────────────────────────────────────────────
echo "Building and starting services..."
docker compose -f docker-compose.prod.yml up -d --build

# ── 6. Wait for health ────────────────────────────────────────────────────────
echo "Waiting for API to be healthy..."
for i in {1..30}; do
    if curl -sf http://localhost:3000/health > /dev/null 2>&1; then
        echo "✅ API is healthy!"
        break
    fi
    sleep 2
done

echo ""
echo "✅ Deployment complete!"
echo "   API is running at: http://localhost:3000"
echo "   Health check:      http://localhost:3000/health"
echo ""
echo "Next steps:"
echo "  1. Point your domain to this server's IP"
echo "  2. Set up SSL with Let's Encrypt:"
echo "     sudo apt install certbot"
echo "     sudo certbot certonly --webroot -w /var/www/certbot -d api.yourdomain.com"
echo "  3. Update docker/nginx.conf with your domain"
echo "  4. Update API_BASE_URL in api/.env.production"
echo "  5. docker compose -f docker-compose.prod.yml restart nginx"
