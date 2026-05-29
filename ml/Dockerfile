# ── PrivID ML Service ─────────────────────────────────────────────────────────
# Multi-stage build: keeps the final image lean by separating build deps
# from the runtime image.
#
# Railway sets PORT automatically; uvicorn reads it from the env.
# ─────────────────────────────────────────────────────────────────────────────

FROM python:3.11-slim AS base

# System deps for lightgbm + onnxruntime
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Install Python deps ───────────────────────────────────────────────────────
FROM base AS deps
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r requirements.txt

# ── Production image ──────────────────────────────────────────────────────────
FROM deps AS runtime
COPY . .

# Create models directory (populated at first run / volume mount)
RUN mkdir -p /app/models

# Non-root user for security
RUN useradd -m -u 1001 mluser && chown -R mluser /app
USER mluser

# Railway injects PORT; default 8001 for local dev
ENV PORT=8001
ENV MODEL_DIR=/app/models

EXPOSE $PORT

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port $PORT --workers 2"]
