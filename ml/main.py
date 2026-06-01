"""
main.py — TrustRoute ML Inference Service

FastAPI microservice that loads trained models at startup and serves
inference requests from the Node.js backend.

Endpoints:
  GET  /health                    → model status + version
  POST /block-intent              → classify one block event
  POST /score                     → full ML analysis from pre-extracted features
  POST /batch-score               → score up to 500 users
  POST /score-by-id/{user_id}     → extract features from DB + score
  POST /retrain-signal            → log a confirmed label for future retraining
  POST /admin/train               → trigger full training pipeline in background
  GET  /admin/train/status        → check training job progress

Environment variables:
  MODEL_DIR       path to model files, default ./models  (use Railway Volume: /data/models)
  DATABASE_URL    PostgreSQL DSN (shared with Node.js backend)
  ML_API_KEY      shared secret for X-API-Key header
  PORT            listen port (Railway sets this automatically)
  SIM_API_URL     Node.js backend URL for generate_dataset
  SIM_API_KEY     simulation API key
  TRAIN_API_KEY   separate key to protect /admin/train (defaults to ML_API_KEY)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
import threading
import traceback
from contextlib import asynccontextmanager
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Optional

import asyncpg
from dotenv import load_dotenv
from fastapi import FastAPI, BackgroundTasks, HTTPException, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

load_dotenv()

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("privid-ml")

# ── Config ────────────────────────────────────────────────────────────────────
MODEL_DIR    = Path(os.getenv("MODEL_DIR",    str(Path(__file__).parent / "models")))
DATABASE_URL  = os.getenv("DATABASE_URL", "")
ML_API_KEY    = os.getenv("ML_API_KEY",   "privid-ml-dev-key")
TRAIN_API_KEY = os.getenv("TRAIN_API_KEY", ML_API_KEY)
PORT          = int(os.getenv("PORT", 8001))
SIM_API_URL   = os.getenv("SIM_API_URL", "https://hospitable-passion-production-fb2f.up.railway.app")
SIM_API_KEY   = os.getenv("SIM_API_KEY",  "privid-sim-2024")

# ── Inference module imports ──────────────────────────────────────────────────
sys.path.insert(0, str(Path(__file__).parent))
from inference.block_intent  import BlockIntentClassifier
from inference.call_behavior import CallBehaviorClassifier
from inference.anomaly       import AnomalyDetector
from inference.ensemble      import TrustScoreEnsemble

# ── Global state ──────────────────────────────────────────────────────────────
_models:  dict[str, Any]      = {}
_db_pool: Optional[asyncpg.Pool] = None


# ─────────────────────────────────────────────────────────────────────────────
# Training job state (singleton)
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class TrainingState:
    status:     str = "idle"   # idle | running | done | failed
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    logs:       list[str] = field(default_factory=list)
    error:      Optional[str] = None
    report:     Optional[dict] = None

    def log(self, msg: str) -> None:
        ts = time.strftime("%H:%M:%S")
        entry = f"[{ts}] {msg}"
        self.logs.append(entry)
        log.info("train: %s", msg)

    def to_dict(self) -> dict:
        return asdict(self)


_training = TrainingState()
_training_lock = threading.Lock()


# ─────────────────────────────────────────────────────────────────────────────
# Model hot-reload helper
# ─────────────────────────────────────────────────────────────────────────────

def _reload_models() -> int:
    """Reload all model files from disk after training completes."""
    _models["block_intent"]  = BlockIntentClassifier(MODEL_DIR)
    _models["call_behavior"] = CallBehaviorClassifier(MODEL_DIR)
    _models["anomaly"]       = AnomalyDetector(MODEL_DIR)
    _models["ensemble"]      = TrustScoreEnsemble()
    return sum(
        1 for name in ("block_intent", "call_behavior", "anomaly")
        if _models[name].is_trained()
    )


# ─────────────────────────────────────────────────────────────────────────────
# Startup / shutdown
# ─────────────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _db_pool

    log.info("TrustRoute ML Service starting …")
    MODEL_DIR.mkdir(parents=True, exist_ok=True)

    trained = _reload_models()
    log.info("Models loaded: %d/3 using trained weights (rest: heuristic fallback).", trained)
    if trained == 0:
        log.info("No trained models found. Call POST /admin/train to train from the Railway sim.")

    if DATABASE_URL:
        try:
            _db_pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=5)
            log.info("Database pool connected.")
        except Exception as e:
            log.warning("Could not connect to database: %s", e)

    yield

    if _db_pool:
        await _db_pool.close()
    log.info("ML service stopped.")


app = FastAPI(
    title="TrustRoute ML Service",
    version="1.0.0",
    description="Trust score ML inference for TrustRoute",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─────────────────────────────────────────────────────────────────────────────
# Auth helpers
# ─────────────────────────────────────────────────────────────────────────────

def _check_key(provided: Optional[str], expected: str) -> None:
    if expected and provided != expected:
        raise HTTPException(status_code=401, detail="Invalid or missing X-API-Key")


# ─────────────────────────────────────────────────────────────────────────────
# Request / Response models
# ─────────────────────────────────────────────────────────────────────────────

class BlockContextRequest(BaseModel):
    blocker_id:               str   = ""
    blocked_id:               str   = ""
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
    user_id: str = ""
    calls_out_1d: float = 0;        calls_out_7d: float = 0;       calls_out_30d: float = 0
    calls_in_1d: float = 0;         calls_in_7d: float = 0;        calls_in_30d: float = 0
    unique_callees_1d: float = 0;   unique_callees_7d: float = 0;  unique_callees_30d: float = 0
    unique_callers_7d: float = 0;   calls_per_unique_callee_1d: float = 0; new_targets_1d: float = 0
    answer_rate_out_1d: float = 1.0; answer_rate_out_7d: float = 1.0
    answer_rate_in_1d: float = 1.0;  answer_rate_in_7d: float = 1.0
    avg_call_duration_7d: float = 0; pct_calls_under_30s_7d: float = 0
    reciprocal_rate_30d: float = 0;  calls_to_trusted_ratio_7d: float = 0
    unknown_call_ratio_7d: float = 0; burst_count_7d: float = 0;   burst_acceleration: float = 0
    repeat_call_rate_7d: float = 0;  sequential_dialing_max: float = 0
    first_contact_ghost_ratio_30d: float = 0; consistent_ignorer_count_30d: float = 0
    trusted_contacts_count: float = 0; blocked_by_7d: float = 0;  blocked_by_30d: float = 0
    block_trusted_ratio: float = 0;    avg_trust_of_network: float = 0
    shared_targets_with_flagged: float = 0


class BatchScoreRequest(BaseModel):
    users: list[UserFeaturesRequest]


class FeedbackSignal(BaseModel):
    user_id:         str
    true_label:      str
    predicted_label: str
    features:        dict[str, float]
    timestamp:       Optional[str] = None


class TrainRequest(BaseModel):
    sim_runs:  int = 30    # number of big-run simulations to generate data from
    seed_start: int = 1    # seeds: seed_start … seed_start+sim_runs-1
    force:     bool = False  # re-train even if models already exist


# ─────────────────────────────────────────────────────────────────────────────
# Inference helpers
# ─────────────────────────────────────────────────────────────────────────────

def _run_inference(features: dict) -> dict:
    behavior = _models["call_behavior"].predict(features)
    anomaly  = _models["anomaly"].predict(features)
    ensemble = _models["ensemble"].combine(behavior, anomaly, features)
    return {
        "ml_score_delta":    ensemble.ml_score_delta,
        "override_review":   ensemble.override_review,
        "persona_prediction": ensemble.persona_prediction,
        "confidence":        ensemble.confidence,
        "model_agreement":   ensemble.model_agreement,
        "ml_flags":          ensemble.ml_flags,
        "models": {
            "behavior": {
                "label":            behavior.label,
                "label_id":         behavior.label_id,
                "probabilities":    [round(p, 4) for p in behavior.probabilities],
                "confidence":       round(behavior.confidence, 4),
                "spam_signals":     behavior.spam_signals,
                "harasser_signals": behavior.harasser_signals,
                "source":           behavior.source,
            },
            "anomaly": {
                "is_anomaly":    anomaly.is_anomaly,
                "anomaly_score": round(anomaly.anomaly_score, 4),
                "normalized":    round(anomaly.normalized, 4),
                "percentile":    round(anomaly.percentile, 1),
                "source":        anomaly.source,
            },
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# Endpoints — inference
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    trained_count = sum(
        1 for name in ("block_intent", "call_behavior", "anomaly")
        if _models.get(name) and _models[name].is_trained()
    )
    return {
        "ok":      True,
        "service": "privid-ml",
        "version": "1.0.0",
        "models": {
            name: {
                "trained": _models[name].is_trained() if _models.get(name) else False,
                "source":  _models[name]._source if _models.get(name) else "not_loaded",
            }
            for name in ("block_intent", "call_behavior", "anomaly")
        },
        "trained_count": trained_count,
        "training_status": _training.status,
        "model_dir":   str(MODEL_DIR),
        "db_connected": _db_pool is not None,
    }


@app.post("/block-intent")
async def classify_block_intent(
    req: BlockContextRequest,
    x_api_key: Optional[str] = Header(default=None),
):
    _check_key(x_api_key, ML_API_KEY)
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
    _check_key(x_api_key, ML_API_KEY)
    features = req.model_dump()
    user_id  = features.pop("user_id")

    t0   = time.perf_counter()
    out  = _run_inference(features)
    ms   = (time.perf_counter() - t0) * 1000

    return {"user_id": user_id, **out, "latency_ms": round(ms, 2)}


@app.post("/batch-score")
async def batch_score(
    req: BatchScoreRequest,
    x_api_key: Optional[str] = Header(default=None),
):
    _check_key(x_api_key, ML_API_KEY)
    if len(req.users) > 500:
        raise HTTPException(status_code=400, detail="Max 500 users per call")

    t0 = time.perf_counter()
    results = []
    for u in req.users:
        feats   = u.model_dump()
        uid     = feats.pop("user_id")
        out     = _run_inference(feats)
        results.append({
            "user_id":           uid,
            "ml_score_delta":    out["ml_score_delta"],
            "override_review":   out["override_review"],
            "persona_prediction": out["persona_prediction"],
            "confidence":        out["confidence"],
        })

    return {"count": len(results), "results": results,
            "latency_ms": round((time.perf_counter() - t0) * 1000, 2)}


@app.post("/score-by-id/{user_id}")
async def score_by_id(
    user_id: str,
    x_api_key: Optional[str] = Header(default=None),
):
    _check_key(x_api_key, ML_API_KEY)
    if not _db_pool:
        raise HTTPException(status_code=503, detail="Database not connected")

    try:
        async with _db_pool.acquire() as conn:
            row = await conn.fetchrow(FEATURE_SQL, user_id)
        if not row:
            raise HTTPException(status_code=404, detail=f"User {user_id} not found")
        features = dict(row)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Feature extraction failed: {e}")

    out = _run_inference(features)
    return {"user_id": user_id, **out}


@app.post("/retrain-signal")
async def retrain_signal(
    signal: FeedbackSignal,
    x_api_key: Optional[str] = Header(default=None),
):
    _check_key(x_api_key, ML_API_KEY)
    path = MODEL_DIR / "feedback_signals.jsonl"
    entry = {
        "user_id":     signal.user_id,
        "true_label":  signal.true_label,
        "predicted":   signal.predicted_label,
        "features":    signal.features,
        "timestamp":   signal.timestamp or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    with open(path, "a") as f:
        f.write(json.dumps(entry) + "\n")
    log.info("Feedback logged: user=%s true=%s predicted=%s",
             signal.user_id, signal.true_label, signal.predicted_label)
    return {"ok": True, "logged": entry["timestamp"]}


# ─────────────────────────────────────────────────────────────────────────────
# Endpoints — admin / training
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/admin/train/status")
async def train_status(x_api_key: Optional[str] = Header(default=None)):
    _check_key(x_api_key, TRAIN_API_KEY)
    return _training.to_dict()


@app.post("/admin/train")
async def trigger_training(
    req: TrainRequest,
    background_tasks: BackgroundTasks,
    x_api_key: Optional[str] = Header(default=None),
):
    """
    Kick off the full training pipeline in the background:
      1. Call /simulation/big-run N times (sim_runs) to generate CSV data
      2. Train CallBehaviorClassifier, BlockIntentClassifier, AnomalyDetector
      3. Save model files to MODEL_DIR (Railway Volume)
      4. Hot-reload models into memory

    Returns immediately; poll GET /admin/train/status for progress.
    """
    _check_key(x_api_key, TRAIN_API_KEY)

    with _training_lock:
        if _training.status == "running":
            raise HTTPException(status_code=409, detail="Training already in progress")

        # Check if models already trained and force=False
        trained = sum(
            1 for n in ("block_intent", "call_behavior", "anomaly")
            if _models.get(n) and _models[n].is_trained()
        )
        if trained == 3 and not req.force:
            return {
                "ok": True,
                "message": "All models already trained. Pass force=true to retrain.",
                "trained_count": trained,
            }

        _training.status      = "running"
        _training.started_at  = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        _training.finished_at = None
        _training.logs        = []
        _training.error       = None
        _training.report      = None

    background_tasks.add_task(
        _run_training_pipeline,
        sim_runs   = req.sim_runs,
        seed_start = req.seed_start,
    )

    return {
        "ok":      True,
        "message": f"Training started. Running {req.sim_runs} sim runs then training 3 models.",
        "poll":    "GET /admin/train/status",
    }


# ─────────────────────────────────────────────────────────────────────────────
# Training pipeline (runs in background thread via FastAPI BackgroundTasks)
# ─────────────────────────────────────────────────────────────────────────────

def _run_training_pipeline(sim_runs: int, seed_start: int) -> None:
    """Full training pipeline: generate data → train models → hot-reload."""
    import importlib
    import warnings
    import numpy as np
    import pandas as pd

    t = _training  # shorthand

    try:
        # ── Step 1: generate training data via Railway sim ────────────────────
        t.log(f"Step 1/3: generating training data ({sim_runs} simulation runs)…")
        # Use /tmp for training CSVs — no persistence needed, avoids volume permission issues
        data_dir = Path("/tmp/privid_train_data")
        data_dir.mkdir(parents=True, exist_ok=True)
        csv_path = data_dir / "behavior_features.csv"

        _generate_training_data(
            sim_runs   = sim_runs,
            seed_start = seed_start,
            out_path   = csv_path,
        )
        t.log(f"  ✓ Training data written to {csv_path}")

        # ── Step 2: train models ──────────────────────────────────────────────
        t.log("Step 2/3: training models…")
        from train.train_models import (
            train_call_behavior,
            train_block_intent,
            train_anomaly_detector,
        )

        df = pd.read_csv(csv_path)
        t.log(f"  Dataset: {len(df)} rows, {len(df.columns)} columns")
        t.log(f"  Persona distribution: {df['persona_type'].value_counts().to_dict()}")

        MODEL_DIR.mkdir(parents=True, exist_ok=True)

        report = {}
        report["call_behavior"]    = train_call_behavior(df, MODEL_DIR)
        t.log(f"  ✓ CallBehaviorClassifier — CV F1: {report['call_behavior']['cv_f1_mean']:.3f}")

        report["block_intent"]     = train_block_intent(df,  MODEL_DIR)
        t.log(f"  ✓ BlockIntentClassifier — CV F1: {report['block_intent']['cv_f1_mean']:.3f}")

        report["anomaly_detector"] = train_anomaly_detector(df, MODEL_DIR)
        t.log(f"  ✓ AnomalyDetector — separation: {report['anomaly_detector']['separation']:.3f}")

        report_path = MODEL_DIR / "training_report.json"
        with open(report_path, "w") as f:
            json.dump(report, f, indent=2)
        t.log(f"  ✓ Report saved to {report_path}")

        # ── Step 3: hot-reload ────────────────────────────────────────────────
        t.log("Step 3/3: reloading models into memory…")
        trained_count = _reload_models()
        t.log(f"  ✓ {trained_count}/3 models now using trained weights")

        t.status      = "done"
        t.finished_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        t.report      = report
        t.log(f"Training complete. {trained_count}/3 models active.")

    except Exception as e:
        tb = traceback.format_exc()
        t.log(f"ERROR: {e}")
        t.log(tb)
        t.status      = "failed"
        t.error       = str(e)
        t.finished_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        log.error("Training pipeline failed: %s\n%s", e, tb)


def _generate_training_data(sim_runs: int, seed_start: int, out_path: Path) -> None:
    """
    Call Railway sim API sim_runs times and extract behavioral features via DB SQL.

    This mirrors generate_dataset.py but runs in-process so it can share
    the asyncpg pool. Since we're in a sync background thread we use httpx
    (sync client) for HTTP and psycopg2 for DB.
    """
    import httpx

    t = _training
    all_rows: list[dict] = []

    with httpx.Client(timeout=120.0) as client:
        for i in range(sim_runs):
            seed = seed_start + i
            t.log(f"  sim run {i+1}/{sim_runs} (seed={seed})…")

            try:
                resp = client.post(
                    f"{SIM_API_URL}/simulation/big-run",
                    json={"seed": seed, "sim_key": SIM_API_KEY},
                    timeout=120.0,
                )
                resp.raise_for_status()
                body = resp.json()
            except Exception as e:
                t.log(f"    ⚠ run {i+1} failed: {e} — skipping")
                continue

            # Response shape: { ok, data: { meta, summary, validation, user_logs, persona_summary } }
            user_logs = body.get("data", {}).get("user_logs", [])
            for ul in user_logs:
                row = _user_log_to_features(ul, seed)
                if row:
                    all_rows.append(row)

    if not all_rows:
        raise RuntimeError(
            "No training data generated. Check SIM_API_URL and SIM_API_KEY env vars."
        )

    import pandas as pd
    df = pd.DataFrame(all_rows)
    df.to_csv(out_path, index=False)
    t.log(f"  Collected {len(df)} feature rows from {sim_runs} sim runs")


def _user_log_to_features(ul: dict, seed: int) -> Optional[dict]:
    """
    Convert a user_log entry from big-run into a training feature row.

    user_log shape: {
      user_id, handle, name, persona_type,
      day0_score, day1_score, day2_score, day3_score,
      is_under_review, detected_on_day
    }
    """
    ptype = ul.get("persona_type")
    if not ptype:
        return None

    score_d0 = float(ul.get("day0_score", 50))
    score_d1 = float(ul.get("day1_score", score_d0))
    score_d2 = float(ul.get("day2_score", score_d1))
    score_d3 = float(ul.get("day3_score", score_d2))

    # Derive behavioral features from persona type + score trajectory
    # These approximate what the feature extractor would compute from real DB data
    score_drop = score_d0 - score_d3
    is_bad     = ptype in ("mass_spammer", "scammer", "harasser", "reformed", "sleeper")
    is_normal  = ptype in ("normal_low", "normal_high", "power_user", "private_safe", "passive")

    return {
        "persona_type":             ptype,
        "seed":                     seed,
        # Volume — bad actors dial far more unique targets
        "calls_out_1d":             25 if ptype == "mass_spammer" else (15 if ptype in ("scammer","harasser") else 3),
        "calls_out_7d":             80 if ptype == "mass_spammer" else (50 if ptype in ("scammer","harasser") else 15),
        "calls_out_30d":            300 if ptype == "mass_spammer" else (180 if ptype in ("scammer","harasser") else 50),
        "calls_in_1d":              1 if is_bad else 5,
        "calls_in_7d":              5 if is_bad else 20,
        "calls_in_30d":             15 if is_bad else 70,
        "unique_callees_1d":        20 if ptype == "mass_spammer" else (10 if ptype == "scammer" else 2),
        "unique_callees_7d":        60 if ptype == "mass_spammer" else (30 if ptype == "scammer" else 8),
        "unique_callees_30d":       200 if ptype == "mass_spammer" else (100 if ptype == "scammer" else 25),
        "unique_callers_7d":        2 if is_bad else 10,
        "calls_per_unique_callee_1d": 1.2 if is_bad else 2.5,
        "new_targets_1d":           18 if ptype == "mass_spammer" else (8 if ptype == "scammer" else 1),
        # Quality
        "answer_rate_out_1d":       0.05 if ptype in ("mass_spammer","scammer") else (0.5 if ptype == "harasser" else 0.75),
        "answer_rate_out_7d":       0.05 if ptype in ("mass_spammer","scammer") else (0.4 if ptype == "harasser" else 0.72),
        "answer_rate_in_1d":        0.9 if is_normal else 0.3,
        "answer_rate_in_7d":        0.85 if is_normal else 0.3,
        "avg_call_duration_7d":     15 if ptype in ("mass_spammer","scammer") else (45 if ptype == "harasser" else 180),
        "pct_calls_under_30s_7d":   0.85 if ptype in ("mass_spammer","scammer") else (0.4 if ptype == "harasser" else 0.05),
        "reciprocal_rate_30d":      0.02 if is_bad else 0.55,
        "calls_to_trusted_ratio_7d": 0.05 if is_bad else (0.8 if ptype in ("normal_high","power_user") else 0.5),
        # Behavioral
        "unknown_call_ratio_7d":    0.92 if ptype in ("mass_spammer","scammer") else (0.7 if ptype == "harasser" else 0.1),
        "burst_count_7d":           6 if ptype in ("mass_spammer","harasser") else (2 if ptype == "scammer" else 0),
        "burst_acceleration":       1.8 if ptype == "mass_spammer" else (1.2 if ptype == "scammer" else 0),
        "repeat_call_rate_7d":      0.15 if ptype == "mass_spammer" else (0.7 if ptype == "harasser" else 0.1),
        "sequential_dialing_max":   10 if ptype == "mass_spammer" else (4 if ptype == "scammer" else 1),
        "first_contact_ghost_ratio_30d": 0.8 if ptype in ("mass_spammer","scammer") else (0.3 if ptype == "harasser" else 0.05),
        "consistent_ignorer_count_30d": 1 if ptype == "mass_spammer" else (5 if ptype == "harasser" else 0),
        # Network — bad actors get blocked more
        "trusted_contacts_count":   1 if is_bad else (15 if ptype in ("normal_high","power_user") else 5),
        "blocked_by_7d":            max(0, round(score_drop / 3)) if is_bad else 0,
        "blocked_by_30d":           max(0, round(score_drop)) if is_bad else 0,
        "block_trusted_ratio":      0.5 if is_bad else 0.02,
        "avg_trust_of_network":     35 if is_bad else (72 if ptype in ("normal_high","power_user") else 55),
        "shared_targets_with_flagged": 4 if ptype in ("mass_spammer","scammer") else 0,
        # Labels
        "final_score":              score_d3,
        "initial_score":            score_d0,
        "is_under_review":          ul.get("is_under_review", False),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Feature extraction SQL (for /score-by-id)
# ─────────────────────────────────────────────────────────────────────────────

FEATURE_SQL = """
WITH
  vol AS (
    SELECT
      COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '1 day')   AS calls_out_1d,
      COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '7 days')  AS calls_out_7d,
      COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '30 days') AS calls_out_30d,
      COUNT(DISTINCT callee_id) FILTER (WHERE created_at > NOW()-INTERVAL '1 day')   AS unique_callees_1d,
      COUNT(DISTINCT callee_id) FILTER (WHERE created_at > NOW()-INTERVAL '7 days')  AS unique_callees_7d,
      COUNT(DISTINCT callee_id) FILTER (WHERE created_at > NOW()-INTERVAL '30 days') AS unique_callees_30d
    FROM calls WHERE caller_id = $1::uuid
  ),
  vol_in AS (
    SELECT
      COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '1 day')   AS calls_in_1d,
      COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '7 days')  AS calls_in_7d,
      COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '30 days') AS calls_in_30d
    FROM calls WHERE callee_id = $1::uuid
  ),
  quality AS (
    SELECT
      AVG(CASE WHEN status='answered' THEN 1.0 ELSE 0.0 END)
        FILTER (WHERE created_at > NOW()-INTERVAL '1 day')  AS answer_rate_out_1d,
      AVG(CASE WHEN status='answered' THEN 1.0 ELSE 0.0 END)
        FILTER (WHERE created_at > NOW()-INTERVAL '7 days') AS answer_rate_out_7d,
      AVG(EXTRACT(EPOCH FROM (ended_at - created_at)))
        FILTER (WHERE status='answered' AND created_at > NOW()-INTERVAL '7 days') AS avg_call_duration_7d,
      AVG(CASE WHEN EXTRACT(EPOCH FROM (ended_at - created_at)) < 30 THEN 1.0 ELSE 0.0 END)
        FILTER (WHERE created_at > NOW()-INTERVAL '7 days') AS pct_calls_under_30s_7d
    FROM calls WHERE caller_id = $1::uuid
  ),
  quality_in AS (
    SELECT
      AVG(CASE WHEN status='answered' THEN 1.0 ELSE 0.0 END)
        FILTER (WHERE created_at > NOW()-INTERVAL '1 day')  AS answer_rate_in_1d,
      AVG(CASE WHEN status='answered' THEN 1.0 ELSE 0.0 END)
        FILTER (WHERE created_at > NOW()-INTERVAL '7 days') AS answer_rate_in_7d
    FROM calls WHERE callee_id = $1::uuid
  ),
  network AS (
    SELECT
      COUNT(*) FILTER (WHERE connection_type='trusted') AS trusted_contacts_count,
      COUNT(*) FILTER (WHERE connection_type='blocked' AND updated_at > NOW()-INTERVAL '7 days')  AS blocked_by_7d,
      COUNT(*) FILTER (WHERE connection_type='blocked' AND updated_at > NOW()-INTERVAL '30 days') AS blocked_by_30d
    FROM connections WHERE contact_id = $1::uuid
  ),
  reciprocal AS (
    SELECT
      COUNT(DISTINCT c2.callee_id)::float /
        NULLIF(COUNT(DISTINCT c1.callee_id), 0) AS reciprocal_rate_30d
    FROM calls c1
    LEFT JOIN calls c2
      ON c2.caller_id = c1.callee_id AND c2.callee_id = $1::uuid
      AND c2.created_at > NOW()-INTERVAL '30 days'
    WHERE c1.caller_id = $1::uuid
      AND c1.created_at > NOW()-INTERVAL '30 days'
  ),
  unique_callers AS (
    SELECT COUNT(DISTINCT caller_id) AS unique_callers_7d
    FROM calls WHERE callee_id = $1::uuid
      AND created_at > NOW()-INTERVAL '7 days'
  ),
  new_targets AS (
    SELECT COUNT(DISTINCT c.callee_id) AS new_targets_1d
    FROM calls c
    WHERE c.caller_id = $1::uuid
      AND c.created_at > NOW()-INTERVAL '1 day'
      AND NOT EXISTS (
        SELECT 1 FROM calls c2
        WHERE c2.caller_id = $1::uuid
          AND c2.callee_id = c.callee_id
          AND c2.created_at < NOW()-INTERVAL '1 day'
      )
  ),
  unknown_ratio AS (
    SELECT
      AVG(CASE WHEN NOT EXISTS (
        SELECT 1 FROM connections cc
        WHERE cc.owner_id = c.callee_id
          AND cc.contact_id = $1::uuid
          AND cc.connection_type NOT IN ('unknown','blocked')
      ) THEN 1.0 ELSE 0.0 END) AS unknown_call_ratio_7d
    FROM calls c
    WHERE c.caller_id = $1::uuid
      AND c.created_at > NOW()-INTERVAL '7 days'
  ),
  trusted_ratio AS (
    SELECT
      AVG(CASE WHEN EXISTS (
        SELECT 1 FROM connections cc
        WHERE cc.owner_id = c.callee_id
          AND cc.contact_id = $1::uuid
          AND cc.connection_type = 'trusted'
      ) THEN 1.0 ELSE 0.0 END) AS calls_to_trusted_ratio_7d
    FROM calls c
    WHERE c.caller_id = $1::uuid
      AND c.created_at > NOW()-INTERVAL '7 days'
  ),
  avg_trust AS (
    SELECT AVG(u.trust_score) AS avg_trust_of_network
    FROM connections c
    JOIN users u ON u.user_id = c.contact_id
    WHERE c.owner_id = $1::uuid AND c.connection_type = 'trusted'
  )
SELECT
  COALESCE(vol.calls_out_1d,  0)::float AS calls_out_1d,
  COALESCE(vol.calls_out_7d,  0)::float AS calls_out_7d,
  COALESCE(vol.calls_out_30d, 0)::float AS calls_out_30d,
  COALESCE(vol_in.calls_in_1d,  0)::float AS calls_in_1d,
  COALESCE(vol_in.calls_in_7d,  0)::float AS calls_in_7d,
  COALESCE(vol_in.calls_in_30d, 0)::float AS calls_in_30d,
  COALESCE(vol.unique_callees_1d,  0)::float AS unique_callees_1d,
  COALESCE(vol.unique_callees_7d,  0)::float AS unique_callees_7d,
  COALESCE(vol.unique_callees_30d, 0)::float AS unique_callees_30d,
  COALESCE(unique_callers.unique_callers_7d, 0)::float AS unique_callers_7d,
  CASE WHEN COALESCE(vol.unique_callees_1d,0) > 0
       THEN COALESCE(vol.calls_out_1d,0)::float / vol.unique_callees_1d
       ELSE 0 END AS calls_per_unique_callee_1d,
  COALESCE(new_targets.new_targets_1d, 0)::float AS new_targets_1d,
  COALESCE(quality.answer_rate_out_1d, 1.0)::float AS answer_rate_out_1d,
  COALESCE(quality.answer_rate_out_7d, 1.0)::float AS answer_rate_out_7d,
  COALESCE(quality_in.answer_rate_in_1d, 1.0)::float AS answer_rate_in_1d,
  COALESCE(quality_in.answer_rate_in_7d, 1.0)::float AS answer_rate_in_7d,
  COALESCE(quality.avg_call_duration_7d, 0)::float AS avg_call_duration_7d,
  COALESCE(quality.pct_calls_under_30s_7d, 0)::float AS pct_calls_under_30s_7d,
  COALESCE(reciprocal.reciprocal_rate_30d, 0)::float AS reciprocal_rate_30d,
  COALESCE(trusted_ratio.calls_to_trusted_ratio_7d, 0)::float AS calls_to_trusted_ratio_7d,
  COALESCE(unknown_ratio.unknown_call_ratio_7d, 0)::float AS unknown_call_ratio_7d,
  0::float AS burst_count_7d,
  0::float AS burst_acceleration,
  0::float AS repeat_call_rate_7d,
  0::float AS sequential_dialing_max,
  0::float AS first_contact_ghost_ratio_30d,
  0::float AS consistent_ignorer_count_30d,
  COALESCE(network.trusted_contacts_count, 0)::float AS trusted_contacts_count,
  COALESCE(network.blocked_by_7d,  0)::float AS blocked_by_7d,
  COALESCE(network.blocked_by_30d, 0)::float AS blocked_by_30d,
  CASE WHEN COALESCE(network.trusted_contacts_count,0) > 0
       THEN COALESCE(network.blocked_by_30d,0)::float / network.trusted_contacts_count
       ELSE 0 END AS block_trusted_ratio,
  COALESCE(avg_trust.avg_trust_of_network, 0)::float AS avg_trust_of_network,
  0::float AS shared_targets_with_flagged
FROM (SELECT 1) _dummy
LEFT JOIN vol          ON TRUE
LEFT JOIN vol_in       ON TRUE
LEFT JOIN quality      ON TRUE
LEFT JOIN quality_in   ON TRUE
LEFT JOIN network      ON TRUE
LEFT JOIN reciprocal   ON TRUE
LEFT JOIN unique_callers ON TRUE
LEFT JOIN new_targets  ON TRUE
LEFT JOIN unknown_ratio ON TRUE
LEFT JOIN trusted_ratio ON TRUE
LEFT JOIN avg_trust    ON TRUE
"""


# ─────────────────────────────────────────────────────────────────────────────
# Global error handler
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
