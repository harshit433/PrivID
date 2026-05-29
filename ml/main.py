"""
main.py — PrivID ML Inference Service

FastAPI microservice that loads all trained models once at startup and
serves inference requests from the Node.js backend.

Endpoints:
  GET  /health                 → model status + version
  POST /score                  → full trust score analysis for a user
  POST /block-intent           → classify a single block event
  POST /batch-score            → score multiple users in one call
  POST /retrain-signal         → log a feedback signal for future retraining

Usage:
  uvicorn main:app --host 0.0.0.0 --port 8001 --reload

Environment variables:
  MODEL_DIR   path to trained model files (default: ./models)
  DATABASE_URL PostgreSQL connection string (for feature extraction)
  API_KEY     shared secret checked on every request (header: X-API-Key)
  PORT        override listen port (Railway sets this automatically)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

import asyncpg
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

load_dotenv()

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("privid-ml")

# ── Config ────────────────────────────────────────────────────────────────────
MODEL_DIR   = Path(os.getenv("MODEL_DIR", str(Path(__file__).parent / "models")))
DATABASE_URL = os.getenv("DATABASE_URL", "")
API_KEY     = os.getenv("ML_API_KEY", "privid-ml-dev-key")
PORT        = int(os.getenv("PORT", 8001))

# ── Import inference modules ──────────────────────────────────────────────────
import sys
sys.path.insert(0, str(Path(__file__).parent))
from inference.block_intent  import BlockIntentClassifier
from inference.call_behavior import CallBehaviorClassifier
from inference.anomaly       import AnomalyDetector
from inference.ensemble      import TrustScoreEnsemble

# ── Global model instances (loaded at startup) ────────────────────────────────
_models: dict[str, Any] = {}
_db_pool: Optional[asyncpg.Pool] = None

# ─────────────────────────────────────────────────────────────────────────────
# Startup / shutdown
# ─────────────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _db_pool

    log.info("Loading models from %s …", MODEL_DIR)
    MODEL_DIR.mkdir(parents=True, exist_ok=True)

    _models["block_intent"]    = BlockIntentClassifier(MODEL_DIR)
    _models["call_behavior"]   = CallBehaviorClassifier(MODEL_DIR)
    _models["anomaly"]         = AnomalyDetector(MODEL_DIR)
    _models["ensemble"]        = TrustScoreEnsemble()

    trained = sum(
        1 for name in ("block_intent", "call_behavior", "anomaly")
        if _models[name].is_trained()
    )
    log.info("Models loaded. %d/3 using trained weights.", trained)

    if DATABASE_URL:
        try:
            _db_pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=5)
            log.info("Database pool connected.")
        except Exception as e:
            log.warning("Could not connect to database: %s", e)
            log.warning("Feature extraction via /score/{user_id} will be unavailable.")

    yield

    if _db_pool:
        await _db_pool.close()
    log.info("ML service shut down.")


app = FastAPI(
    title="PrivID ML Service",
    version="1.0.0",
    description="Trust score ML inference for PrivID",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─────────────────────────────────────────────────────────────────────────────
# Auth middleware
# ─────────────────────────────────────────────────────────────────────────────

def _check_api_key(x_api_key: Optional[str]) -> None:
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing X-API-Key header")


# ─────────────────────────────────────────────────────────────────────────────
# Request / Response models
# ─────────────────────────────────────────────────────────────────────────────

class BlockContextRequest(BaseModel):
    blocker_id:               str
    blocked_id:               str
    calls_before_block:       float = 0
    days_known_before_block:  float = 0
    was_ever_trusted:         bool  = False
    block_speed_hours:        float = 9999
    answered_before_block:    float = 0
    avg_duration_before_block: float = 0
    mutual_call_count:        float = 0
    callee_block_propensity:  float = 0
    block_cluster_24h:        float = 0


class UserFeaturesRequest(BaseModel):
    user_id: str
    # Volume
    calls_out_1d: float = 0; calls_out_7d: float = 0; calls_out_30d: float = 0
    calls_in_1d: float = 0;  calls_in_7d: float = 0;  calls_in_30d: float = 0
    unique_callees_1d: float = 0; unique_callees_7d: float = 0; unique_callees_30d: float = 0
    unique_callers_7d: float = 0; calls_per_unique_callee_1d: float = 0; new_targets_1d: float = 0
    # Quality
    answer_rate_out_1d: float = 1.0; answer_rate_out_7d: float = 1.0
    answer_rate_in_1d: float = 1.0;  answer_rate_in_7d: float = 1.0
    avg_call_duration_7d: float = 0; pct_calls_under_30s_7d: float = 0
    reciprocal_rate_30d: float = 0; calls_to_trusted_ratio_7d: float = 0
    # Behavioral
    unknown_call_ratio_7d: float = 0; burst_count_7d: float = 0; burst_acceleration: float = 0
    repeat_call_rate_7d: float = 0; sequential_dialing_max: float = 0
    first_contact_ghost_ratio_30d: float = 0; consistent_ignorer_count_30d: float = 0
    # Network
    trusted_contacts_count: float = 0; blocked_by_7d: float = 0; blocked_by_30d: float = 0
    block_trusted_ratio: float = 0; avg_trust_of_network: float = 0
    shared_targets_with_flagged: float = 0


class BatchScoreRequest(BaseModel):
    users: list[UserFeaturesRequest]


class FeedbackSignal(BaseModel):
    user_id:        str
    true_label:     str   # actual persona type confirmed by human review
    predicted_label: str
    features:       dict[str, float]
    timestamp:      Optional[str] = None


# ─────────────────────────────────────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    """Returns model status and version info."""
    return {
        "ok":      True,
        "service": "privid-ml",
        "version": "1.0.0",
        "models": {
            "block_intent":   {"trained": _models["block_intent"].is_trained(),   "source": _models["block_intent"]._source},
            "call_behavior":  {"trained": _models["call_behavior"].is_trained(),  "source": _models["call_behavior"]._source},
            "anomaly":        {"trained": _models["anomaly"].is_trained(),         "source": _models["anomaly"]._source},
            "ensemble":       {"trained": True, "source": "heuristic"},
        },
        "model_dir": str(MODEL_DIR),
        "db_connected": _db_pool is not None,
    }


@app.post("/block-intent")
async def classify_block_intent(
    req: BlockContextRequest,
    x_api_key: Optional[str] = Header(default=None),
):
    """
    Classify a single block event into personal_dispute | spam_block | harassment_block.

    Called by trustScore.ts getStaticBehaviorPenalty() for each block in the
    30-day window of the user being scored.
    """
    _check_api_key(x_api_key)

    ctx = req.model_dump()
    ctx["was_ever_trusted"] = int(ctx["was_ever_trusted"])

    t0     = time.perf_counter()
    result = _models["block_intent"].predict(ctx)
    ms     = (time.perf_counter() - t0) * 1000

    return {
        "label":        result.label,
        "p_personal":   round(result.p_personal, 4),
        "p_spam":       round(result.p_spam, 4),
        "p_harassment": round(result.p_harassment, 4),
        "weight":       result.weight,
        "penalty_pts":  result.penalty_pts,
        "confidence":   round(result.confidence, 4),
        "source":       result.source,
        "latency_ms":   round(ms, 2),
    }


@app.post("/score")
async def score_user(
    req: UserFeaturesRequest,
    x_api_key: Optional[str] = Header(default=None),
):
    """
    Full ML trust score analysis for a single user.

    Accepts pre-extracted features. Returns a score delta and explanations
    to be combined with the rule-based score in trustScore.ts.

    The Node.js backend should:
      1. Extract features via featureStore.extractFeatures(userId)
      2. Call this endpoint
      3. Add ml_score_delta to the rule-based score
      4. If override_review = true, set is_under_review = true
    """
    _check_api_key(x_api_key)

    features = req.model_dump()
    user_id  = features.pop("user_id")

    t0 = time.perf_counter()

    behavior = _models["call_behavior"].predict(features)
    anomaly  = _models["anomaly"].predict(features)
    ensemble = _models["ensemble"].combine(behavior, anomaly, features)

    ms = (time.perf_counter() - t0) * 1000
    log.debug("score user=%s delta=%.1f label=%s latency=%.1fms",
              user_id, ensemble.ml_score_delta, behavior.label, ms)

    return {
        "user_id":          user_id,
        "ml_score_delta":   ensemble.ml_score_delta,
        "override_review":  ensemble.override_review,
        "persona_prediction": ensemble.persona_prediction,
        "confidence":       ensemble.confidence,
        "model_agreement":  ensemble.model_agreement,
        "ml_flags":         ensemble.ml_flags,
        "models": {
            "behavior": {
                "label":       behavior.label,
                "label_id":    behavior.label_id,
                "probabilities": [round(p, 4) for p in behavior.probabilities],
                "confidence":  round(behavior.confidence, 4),
                "spam_signals":     behavior.spam_signals,
                "harasser_signals": behavior.harasser_signals,
                "source":      behavior.source,
            },
            "anomaly": {
                "is_anomaly":    anomaly.is_anomaly,
                "anomaly_score": round(anomaly.anomaly_score, 4),
                "normalized":    round(anomaly.normalized, 4),
                "percentile":    round(anomaly.percentile, 1),
                "source":        anomaly.source,
            },
        },
        "latency_ms": round(ms, 2),
    }


@app.post("/batch-score")
async def batch_score_users(
    req: BatchScoreRequest,
    x_api_key: Optional[str] = Header(default=None),
):
    """
    Score multiple users in a single request.
    Useful during big-run simulation and bulk recompute jobs.
    Max 500 users per call.
    """
    _check_api_key(x_api_key)

    if len(req.users) > 500:
        raise HTTPException(status_code=400, detail="Max 500 users per batch-score call")

    t0 = time.perf_counter()
    results = []

    for user_req in req.users:
        features = user_req.model_dump()
        user_id  = features.pop("user_id")
        behavior = _models["call_behavior"].predict(features)
        anomaly  = _models["anomaly"].predict(features)
        ensemble = _models["ensemble"].combine(behavior, anomaly, features)

        results.append({
            "user_id":          user_id,
            "ml_score_delta":   ensemble.ml_score_delta,
            "override_review":  ensemble.override_review,
            "persona_prediction": ensemble.persona_prediction,
            "confidence":       ensemble.confidence,
        })

    ms = (time.perf_counter() - t0) * 1000
    return {
        "count":      len(results),
        "results":    results,
        "latency_ms": round(ms, 2),
    }


@app.post("/retrain-signal")
async def log_retrain_signal(
    signal: FeedbackSignal,
    x_api_key: Optional[str] = Header(default=None),
):
    """
    Accept a human-confirmed feedback signal for retraining.

    When a moderator confirms a user's true persona (e.g. after investigation),
    the Node.js backend sends the label + features here. These are appended to
    a JSONL file for the next training run.

    In production this would write to a database table; for now it writes to
    a local file that generate_dataset.py picks up.
    """
    _check_api_key(x_api_key)

    feedback_path = MODEL_DIR / "feedback_signals.jsonl"
    entry = {
        "user_id":        signal.user_id,
        "true_label":     signal.true_label,
        "predicted":      signal.predicted_label,
        "features":       signal.features,
        "timestamp":      signal.timestamp or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    with open(feedback_path, "a") as f:
        f.write(json.dumps(entry) + "\n")

    log.info("Feedback signal logged: user=%s true=%s predicted=%s",
             signal.user_id, signal.true_label, signal.predicted_label)

    return {"ok": True, "logged": entry["timestamp"]}


@app.post("/score-by-id/{user_id}")
async def score_user_by_id(
    user_id: str,
    x_api_key: Optional[str] = Header(default=None),
):
    """
    Score a user by ID — extracts features directly from the database.

    Requires DATABASE_URL to be set. This endpoint is called by the
    Node.js backend after a significant event (new block, mass outreach flag, etc.)
    to get the ML delta without the Node side needing to extract features itself.
    """
    _check_api_key(x_api_key)

    if not _db_pool:
        raise HTTPException(
            status_code=503,
            detail="Database not connected. Use /score with pre-extracted features instead."
        )

    try:
        features = await _extract_features_from_db(user_id)
    except Exception as e:
        log.error("Feature extraction failed for user %s: %s", user_id, e)
        raise HTTPException(status_code=500, detail=f"Feature extraction failed: {e}")

    behavior = _models["call_behavior"].predict(features)
    anomaly  = _models["anomaly"].predict(features)
    ensemble = _models["ensemble"].combine(behavior, anomaly, features)

    return {
        "user_id":          user_id,
        "ml_score_delta":   ensemble.ml_score_delta,
        "override_review":  ensemble.override_review,
        "persona_prediction": ensemble.persona_prediction,
        "confidence":       ensemble.confidence,
        "ml_flags":         ensemble.ml_flags,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Feature extraction from DB (used by /score-by-id)
# ─────────────────────────────────────────────────────────────────────────────

async def _extract_features_from_db(user_id: str) -> dict:
    """
    Pull behavioral features for a user directly from PostgreSQL.
    Mirrors the SQL in featureStore.ts but in Python / asyncpg.
    """
    async with _db_pool.acquire() as conn:
        row = await conn.fetchrow(FEATURE_SQL, user_id)

    if not row:
        raise ValueError(f"User {user_id} not found in database")

    return dict(row)


# Large SQL query — mirrors featureStore.ts extractFeatures()
FEATURE_SQL = """
WITH
  vol AS (
    SELECT
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day')   AS calls_out_1d,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')  AS calls_out_7d,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') AS calls_out_30d,
      COUNT(DISTINCT callee_id) FILTER (WHERE created_at > NOW() - INTERVAL '1 day')  AS unique_callees_1d,
      COUNT(DISTINCT callee_id) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS unique_callees_7d
    FROM calls WHERE caller_id = $1::uuid
  ),
  vol_in AS (
    SELECT
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day')  AS calls_in_1d,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS calls_in_7d
    FROM calls WHERE callee_id = $1::uuid
  ),
  quality AS (
    SELECT
      AVG(CASE WHEN status = 'answered' THEN 1.0 ELSE 0.0 END)
        FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS answer_rate_out_7d,
      AVG(EXTRACT(EPOCH FROM (ended_at - created_at)))
        FILTER (WHERE status = 'answered' AND created_at > NOW() - INTERVAL '7 days') AS avg_call_duration_7d,
      AVG(CASE WHEN EXTRACT(EPOCH FROM (ended_at - created_at)) < 30 THEN 1.0 ELSE 0.0 END)
        FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS pct_calls_under_30s_7d
    FROM calls WHERE caller_id = $1::uuid
  ),
  network AS (
    SELECT
      COUNT(*) FILTER (WHERE connection_type = 'trusted') AS trusted_contacts_count,
      COUNT(*) FILTER (WHERE connection_type = 'blocked' AND updated_at > NOW() - INTERVAL '7 days')  AS blocked_by_7d,
      COUNT(*) FILTER (WHERE connection_type = 'blocked' AND updated_at > NOW() - INTERVAL '30 days') AS blocked_by_30d
    FROM connections WHERE contact_id = $1::uuid
  )
SELECT
  COALESCE(vol.calls_out_1d, 0)::float          AS calls_out_1d,
  COALESCE(vol.calls_out_7d, 0)::float          AS calls_out_7d,
  COALESCE(vol.calls_out_30d, 0)::float         AS calls_out_30d,
  COALESCE(vol_in.calls_in_1d, 0)::float        AS calls_in_1d,
  COALESCE(vol_in.calls_in_7d, 0)::float        AS calls_in_7d,
  0::float                                       AS calls_in_30d,
  COALESCE(vol.unique_callees_1d, 0)::float     AS unique_callees_1d,
  COALESCE(vol.unique_callees_7d, 0)::float     AS unique_callees_7d,
  0::float                                       AS unique_callees_30d,
  0::float                                       AS unique_callers_7d,
  CASE WHEN COALESCE(vol.unique_callees_1d, 0) > 0
       THEN COALESCE(vol.calls_out_1d, 0)::float / COALESCE(vol.unique_callees_1d, 1)
       ELSE 0 END                                AS calls_per_unique_callee_1d,
  0::float                                       AS new_targets_1d,
  COALESCE(quality.answer_rate_out_7d, 1.0)::float AS answer_rate_out_7d,
  COALESCE(quality.answer_rate_out_7d, 1.0)::float AS answer_rate_out_1d,
  1.0::float                                     AS answer_rate_in_7d,
  1.0::float                                     AS answer_rate_in_1d,
  COALESCE(quality.avg_call_duration_7d, 0)::float AS avg_call_duration_7d,
  COALESCE(quality.pct_calls_under_30s_7d, 0)::float AS pct_calls_under_30s_7d,
  0::float                                       AS reciprocal_rate_30d,
  0::float                                       AS calls_to_trusted_ratio_7d,
  0::float                                       AS unknown_call_ratio_7d,
  0::float                                       AS burst_count_7d,
  0::float                                       AS burst_acceleration,
  0::float                                       AS repeat_call_rate_7d,
  0::float                                       AS sequential_dialing_max,
  0::float                                       AS first_contact_ghost_ratio_30d,
  0::float                                       AS consistent_ignorer_count_30d,
  COALESCE(network.trusted_contacts_count, 0)::float AS trusted_contacts_count,
  COALESCE(network.blocked_by_7d, 0)::float      AS blocked_by_7d,
  COALESCE(network.blocked_by_30d, 0)::float     AS blocked_by_30d,
  CASE WHEN COALESCE(network.trusted_contacts_count, 0) > 0
       THEN COALESCE(network.blocked_by_30d, 0)::float / COALESCE(network.trusted_contacts_count, 1)
       ELSE 0 END                                AS block_trusted_ratio,
  0::float                                       AS avg_trust_of_network,
  0::float                                       AS shared_targets_with_flagged
FROM (SELECT 1) dummy
LEFT JOIN vol     ON TRUE
LEFT JOIN vol_in  ON TRUE
LEFT JOIN quality ON TRUE
LEFT JOIN network ON TRUE
"""


# ─────────────────────────────────────────────────────────────────────────────
# Error handler
# ─────────────────────────────────────────────────────────────────────────────

@app.exception_handler(Exception)
async def global_error_handler(request: Request, exc: Exception):
    log.error("Unhandled error on %s: %s", request.url.path, exc, exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"ok": False, "error": str(exc)},
    )


# ─────────────────────────────────────────────────────────────────────────────
# Dev entry point
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=PORT, reload=True)
