"""
anomaly.py — Anomaly Detector inference module.

Wraps the trained Isolation Forest. Returns an anomaly score and flag
for unusual behavioral patterns that don't fit known categories.

The anomaly detector is trained exclusively on clean users, so any
unusual calling pattern — even one we haven't seen before — gets flagged.
"""
from __future__ import annotations

import pickle
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np

import sys
sys.path.insert(0, str(Path(__file__).parent.parent))
from features import BEHAVIOR_MODEL_FEATURES


@dataclass
class AnomalyResult:
    is_anomaly:    bool
    anomaly_score: float    # raw IsoForest decision_function score; lower = more anomalous
    normalized:    float    # 0–1, where 1 = most anomalous (for UI display)
    percentile:    float    # approximate percentile vs training data (0–100)
    source:        str      # "sklearn" | "heuristic"


# Approximate threshold: below this decision score = flag as anomaly
_ANOMALY_THRESHOLD = -0.05


class AnomalyDetector:
    """
    Wraps the Isolation Forest model.
    Falls back to a simple statistical outlier check if no model is available.
    """

    def __init__(self, model_dir: str | Path):
        self._model_dir = Path(model_dir)
        self._model     = None
        self._source    = "heuristic"
        self._load()

    def _load(self) -> None:
        pkl_path = self._model_dir / "anomaly_detector.pkl"
        if pkl_path.exists():
            with open(pkl_path, "rb") as f:
                bundle = pickle.load(f)
            self._model  = bundle["model"]
            self._source = "sklearn"
            print(f"  [AnomalyDetector] loaded model from {pkl_path}")
            return

        warnings.warn(
            "AnomalyDetector: no trained model found — using heuristic fallback.",
            stacklevel=2,
        )

    def is_trained(self) -> bool:
        return self._source == "sklearn"

    def _to_vector(self, features: dict) -> np.ndarray:
        return np.array(
            [float(features.get(f, 0.0)) for f in BEHAVIOR_MODEL_FEATURES],
            dtype=np.float32,
        ).reshape(1, -1)

    def predict(self, features: dict) -> AnomalyResult:
        if self._source == "sklearn":
            return self._predict_sklearn(features)
        return self._predict_heuristic(features)

    def _predict_sklearn(self, features: dict) -> AnomalyResult:
        X     = self._to_vector(features)
        score = float(self._model.decision_function(X)[0])
        is_an = score < _ANOMALY_THRESHOLD

        # Normalize: map roughly [-0.3, 0.2] → [1.0, 0.0]
        normalized = float(np.clip((-score + _ANOMALY_THRESHOLD) / 0.25, 0.0, 1.0))
        # Approximate percentile: scored at or below what fraction of normal users
        percentile = float(np.clip(100 * (1 - normalized), 0, 100))

        return AnomalyResult(
            is_anomaly    = is_an,
            anomaly_score = score,
            normalized    = normalized,
            percentile    = percentile,
            source        = "sklearn",
        )

    def _predict_heuristic(self, features: dict) -> AnomalyResult:
        """
        Simple rule-based anomaly check:
        Flag if multiple out-of-range features simultaneously.
        """
        flags = 0

        if features.get("calls_out_1d", 0) > 40:         flags += 2
        elif features.get("calls_out_1d", 0) > 25:       flags += 1
        if features.get("burst_count_7d", 0) > 5:        flags += 2
        if features.get("blocked_by_7d", 0) > 5:         flags += 2
        if features.get("answer_rate_out_7d", 1) < 0.10: flags += 2
        if features.get("sequential_dialing_max", 0) > 8:flags += 1
        if features.get("unique_callees_1d", 0) > 20:    flags += 1

        is_an      = flags >= 4
        normalized = float(min(1.0, flags / 8))
        score      = -normalized * 0.3   # mock decision function score

        return AnomalyResult(
            is_anomaly    = is_an,
            anomaly_score = score,
            normalized    = normalized,
            percentile    = float(max(0, 100 - normalized * 100)),
            source        = "heuristic",
        )
