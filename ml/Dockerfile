# ── TrustRoute ML Service ─────────────────────────────────────────────────────────
# Deployed on Railway as a separate service pointing to backend/ml/ root dir.
# Railway sets PORT automatically; uvicorn reads it from env.
#
# Volume mount: /data/models  (persistent model storage across deploys)
# Set MODEL_DIR=/data/models in Railway service env vars.
# ─────────────────────────────────────────────────────────────────────────────

FROM python:3.11-slim

# System deps: libgomp1 for LightGBM, gcc for building C extensions
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 \
    gcc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first (cached layer — only invalidated when requirements change)
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create default model directory (overridden by Railway Volume at /data/models)
RUN mkdir -p /app/models

RUN mkdir -p /data/models

ENV PORT=8001
ENV MODEL_DIR=/data/models

EXPOSE $PORT

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:$PORT/health')"

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port $PORT --workers 1"]
