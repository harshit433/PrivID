"""
call_behavior.py — Call Behavior Classifier inference module.

Classifies a user's calling behavior into:
  0 = clean      (normal_low, normal_high, power_user, private_safe, passive)
  1 = suspicious (not currently used in training labels but reserved)
  2 = spammer    (mass_spammer, scammer, reformed, sleeper)
  3 = harasser   (harasser)

Input shape: len(BEHAVIOR_MODEL_FEATURES) = 33 features
Output: CallBehaviorResult with class probabilities and anomaly signals.
"""
from __future__ import annotations

import pickle
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np

try:
    import onnxruntime as ort
    _HAS_ONNX = True
except ImportError:
    _HAS_ONNX = False

import sys
sys.path.insert(0, str(Path(__file__).parent.parent))
from features import BEHAVIOR_MODEL_FEATURES, BEHAVIOR_LABEL_NAMES

# Thresholds for rule-based signal generation
_SPAM_SIGNALS: list[tuple[str, str, float]] = [
    # (feature, direction, threshold)
    ("calls_out_1d",               "gte", 20),
    ("unique_callees_1d",          "gte", 15),
    ("answer_rate_out_7d",         "lte",  0.25),
    ("burst_count_7d",             "gte",  3),
    ("first_contact_ghost_ratio_30d", "gte", 0.6),
    ("blocked_by_7d",              "gte",  3),
    ("sequential_dialing_max",     "gte",  5),
]
_HARASSER_SIGNALS: list[tuple[str, str, float]] = [
    ("repeat_call_rate_7d",        "gte",  0.5),
    ("consistent_ignorer_count_30d", "gte", 3),
    ("pct_calls_under_30s_7d",     "gte",  0.7),
    ("blocked_by_30d",             "gte",  5),
]


@dataclass
class CallBehaviorResult:
    label:       str            # clean | suspicious | spammer | harasser
    label_id:    int            # 0–3
    probabilities: list[float]  # [p_clean, p_suspicious, p_spammer, p_harasser]
    confidence:  float          # max probability
    spam_signals:     list[str] = field(default_factory=list)
    harasser_signals: list[str] = field(default_factory=list)
    # ML-derived penalty modifier: 0.0 = no modifier, positive = penalty multiplier
    behavior_modifier: float = 0.0
    source:      str = "unknown"


class CallBehaviorClassifier:
    """
    Wraps the trained LightGBM (or RandomForest fallback) model.

    Priority: ONNX → sklearn pkl → rule-based heuristic.
    """

    def __init__(self, model_dir: str | Path):
        self._model_dir  = Path(model_dir)
        self._onnx_session: Optional[ort.InferenceSession] = None
        self._sklearn_model = None
        self._source = "heuristic"
        self._load()

    # ── Loading ───────────────────────────────────────────────────────────────

    def _load(self) -> None:
        onnx_path = self._model_dir / "call_behavior.onnx"
        pkl_path  = self._model_dir / "call_behavior.pkl"

        if _HAS_ONNX and onnx_path.exists():
            opts = ort.SessionOptions()
            opts.intra_op_num_threads = 2
            self._onnx_session = ort.InferenceSession(
                str(onnx_path), sess_options=opts,
                providers=["CPUExecutionProvider"],
            )
            self._source = "onnx"
            print(f"  [CallBehaviorClassifier] loaded ONNX model from {onnx_path}")
            return

        if pkl_path.exists():
            with open(pkl_path, "rb") as f:
                bundle = pickle.load(f)
            self._sklearn_model = bundle["model"]
            self._source = "sklearn"
            print(f"  [CallBehaviorClassifier] loaded sklearn model from {pkl_path}")
            return

        warnings.warn(
            "CallBehaviorClassifier: no trained model found — using rule-based fallback. "
            "Run train_models.py to generate model files.",
            stacklevel=2,
        )

    def is_trained(self) -> bool:
        return self._source in ("onnx", "sklearn")

    # ── Feature vector ────────────────────────────────────────────────────────

    def _to_vector(self, features: dict) -> np.ndarray:
        return np.array(
            [float(features.get(f, 0.0)) for f in BEHAVIOR_MODEL_FEATURES],
            dtype=np.float32,
        ).reshape(1, -1)

    # ── Inference ─────────────────────────────────────────────────────────────

    def predict(self, features: dict) -> CallBehaviorResult:
        signals = self._compute_signals(features)

        if self._source == "onnx":
            base = self._predict_onnx(features)
        elif self._source == "sklearn":
            base = self._predict_sklearn(features)
        else:
            base = self._predict_heuristic(features)

        base.spam_signals     = signals["spam"]
        base.harasser_signals = signals["harasser"]
        return base

    def _predict_onnx(self, features: dict) -> CallBehaviorResult:
        X = self._to_vector(features)
        inp_name  = self._onnx_session.get_inputs()[0].name
        out_names = [o.name for o in self._onnx_session.get_outputs()]
        outputs   = self._onnx_session.run(out_names, {inp_name: X})

        pred  = int(outputs[0][0])
        proba_raw = outputs[1][0] if len(outputs) > 1 else {}
        proba = [float(proba_raw.get(i, 0.0)) for i in range(len(BEHAVIOR_LABEL_NAMES))]
        return self._build_result(pred, proba, "onnx")

    def _predict_sklearn(self, features: dict) -> CallBehaviorResult:
        X     = self._to_vector(features)
        pred  = int(self._sklearn_model.predict(X)[0])
        proba = self._sklearn_model.predict_proba(X)[0].tolist()
        return self._build_result(pred, proba, "sklearn")

    def _predict_heuristic(self, features: dict) -> CallBehaviorResult:
        """
        Simple rule-based scoring when no model is available.
        Returns class 0 (clean) by default, bumps to spammer/harasser on strong signals.
        """
        spam_score = 0
        har_score  = 0

        for feat, direction, thresh in _SPAM_SIGNALS:
            val = float(features.get(feat, 0.0))
            if direction == "gte" and val >= thresh:
                spam_score += 1
            elif direction == "lte" and val <= thresh:
                spam_score += 1

        for feat, direction, thresh in _HARASSER_SIGNALS:
            val = float(features.get(feat, 0.0))
            if direction == "gte" and val >= thresh:
                har_score += 1

        if har_score >= 3:
            pred  = 3   # harasser
            proba = [0.05, 0.05, 0.10, 0.80]
        elif spam_score >= 4:
            pred  = 2   # spammer
            proba = [0.05, 0.05, 0.80, 0.10]
        elif spam_score >= 2 or har_score >= 1:
            pred  = 1   # suspicious
            proba = [0.20, 0.60, 0.15, 0.05]
        else:
            pred  = 0   # clean
            proba = [0.85, 0.10, 0.03, 0.02]

        return self._build_result(pred, proba, "heuristic")

    # ── Signal detection ──────────────────────────────────────────────────────

    @staticmethod
    def _compute_signals(features: dict) -> dict[str, list[str]]:
        spam_sigs = []
        har_sigs  = []

        calls_1d  = features.get("calls_out_1d", 0)
        callees   = features.get("unique_callees_1d", 0)
        ar_7d     = features.get("answer_rate_out_7d", 1.0)
        bursts    = features.get("burst_count_7d", 0)
        ghost     = features.get("first_contact_ghost_ratio_30d", 0.0)
        blk_7d    = features.get("blocked_by_7d", 0)
        seq_max   = features.get("sequential_dialing_max", 0)
        repeat    = features.get("repeat_call_rate_7d", 0.0)
        ignorers  = features.get("consistent_ignorer_count_30d", 0)
        short_pct = features.get("pct_calls_under_30s_7d", 0.0)
        blk_30d   = features.get("blocked_by_30d", 0)

        if calls_1d >= 30:
            spam_sigs.append(f"very high outgoing call volume ({int(calls_1d)}/day)")
        elif calls_1d >= 20:
            spam_sigs.append(f"high outgoing call volume ({int(calls_1d)}/day)")

        if callees >= 15:
            spam_sigs.append(f"contacting {int(callees)} unique people today")

        if ar_7d <= 0.15:
            spam_sigs.append(f"extremely low answer rate ({ar_7d:.0%}) — calls mostly rejected")
        elif ar_7d <= 0.25:
            spam_sigs.append(f"low answer rate ({ar_7d:.0%})")

        if bursts >= 5:
            spam_sigs.append(f"{int(bursts)} call bursts in 7 days (rapid sequential dialing)")
        elif bursts >= 3:
            spam_sigs.append(f"{int(bursts)} burst events in 7 days")

        if ghost >= 0.7:
            spam_sigs.append(f"{ghost:.0%} of first contacts never called back (ghost rate)")
        elif ghost >= 0.6:
            spam_sigs.append(f"high ghost rate ({ghost:.0%})")

        if blk_7d >= 5:
            spam_sigs.append(f"blocked by {int(blk_7d)} people in 7 days")
        elif blk_7d >= 3:
            spam_sigs.append(f"blocked by {int(blk_7d)} people this week")

        if seq_max >= 8:
            spam_sigs.append(f"sequential dialing detected (max {int(seq_max)} consecutive)")
        elif seq_max >= 5:
            spam_sigs.append(f"possible sequential dialing ({int(seq_max)} in sequence)")

        if repeat >= 0.6 and ignorers >= 3:
            har_sigs.append(f"repeat-calling {int(ignorers)} people who consistently ignore")
        elif repeat >= 0.5:
            har_sigs.append(f"high repeat call rate ({repeat:.0%}) — re-calling rejected contacts")

        if ignorers >= 5:
            har_sigs.append(f"{int(ignorers)} contacts consistently ignore this user's calls")
        elif ignorers >= 3:
            har_sigs.append(f"{int(ignorers)} consistent ignorers (harassment pattern)")

        if short_pct >= 0.8:
            spam_sigs.append(f"{short_pct:.0%} of calls under 30s (robocall / mass-dial pattern)")
        elif short_pct >= 0.7:
            har_sigs.append(f"{short_pct:.0%} of calls end in <30s (unwanted calls)")

        if blk_30d >= 10:
            har_sigs.append(f"blocked by {int(blk_30d)} people in 30 days")

        return {"spam": spam_sigs, "harasser": har_sigs}

    # ── Result builder ────────────────────────────────────────────────────────

    @staticmethod
    def _build_result(
        pred: int,
        proba: list[float],
        source: str,
    ) -> CallBehaviorResult:
        n = len(BEHAVIOR_LABEL_NAMES)
        # Pad / trim proba to match label count
        if len(proba) < n:
            proba = list(proba) + [0.0] * (n - len(proba))
        proba = proba[:n]

        # Normalize
        total = sum(proba)
        if total > 0:
            proba = [p / total for p in proba]
        else:
            proba = [1.0 / n] * n

        label    = BEHAVIOR_LABEL_NAMES[pred] if pred < n else "clean"
        conf     = max(proba)

        # Behavior modifier: float 0.0–1.0 used by the ensemble to scale penalties
        # clean=0, suspicious=0.3, spammer=0.75, harasser=1.0
        _mods = [0.0, 0.3, 0.75, 1.0]
        modifier = _mods[pred] if pred < len(_mods) else 0.0

        return CallBehaviorResult(
            label             = label,
            label_id          = pred,
            probabilities     = proba,
            confidence        = conf,
            behavior_modifier = modifier,
            source            = source,
        )
