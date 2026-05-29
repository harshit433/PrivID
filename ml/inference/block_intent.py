"""
block_intent.py — Block Intent Classifier inference module.

Loads the trained block_intent model (pkl or ONNX) and classifies
a block event into: personal_dispute | spam_block | harassment_block

Input shape: 9 features (BLOCK_CONTEXT_FEATURES order from features.py)
Output: BlockIntentResult with probabilities, label, and penalty weight.
"""
from __future__ import annotations

import pickle
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np

# Try ONNX first (faster at inference time), fall back to sklearn pickle
try:
    import onnxruntime as ort
    _HAS_ONNX = True
except ImportError:
    _HAS_ONNX = False

import sys
sys.path.insert(0, str(Path(__file__).parent.parent))
from features import BLOCK_CONTEXT_FEATURES, BLOCK_INTENT_LABEL_NAMES

# ── Penalty weights — must match blockIntent.ts exactly ──────────────────────
INTENT_WEIGHT = {
    "personal_dispute":  0.1,
    "spam_block":        1.0,
    "harassment_block":  2.5,
}
BASE_BLOCK_PTS = 3.0


@dataclass
class BlockIntentResult:
    label:        str           # personal_dispute | spam_block | harassment_block
    p_personal:   float
    p_spam:       float
    p_harassment: float
    weight:       float         # penalty multiplier
    penalty_pts:  float         # actual pts to subtract
    confidence:   float         # 0–1, max probability
    source:       str           # "onnx" | "sklearn" | "heuristic"


class BlockIntentClassifier:
    """
    Wraps the trained LogisticRegression pipeline.

    Priority:
      1. ONNX model  (block_intent.onnx)  — fastest
      2. sklearn pkl (block_intent.pkl)   — fallback
      3. Pure-heuristic fallback          — if no model files exist
    """

    def __init__(self, model_dir: str | Path):
        self._model_dir = Path(model_dir)
        self._onnx_session: Optional[ort.InferenceSession] = None
        self._sklearn_model = None
        self._label_encoder = None
        self._source = "heuristic"
        self._load()

    # ── Loading ───────────────────────────────────────────────────────────────

    def _load(self) -> None:
        onnx_path  = self._model_dir / "block_intent.onnx"
        pkl_path   = self._model_dir / "block_intent.pkl"
        le_path    = self._model_dir / "block_intent_labels.pkl"

        # Load label encoder (always needed)
        if le_path.exists():
            with open(le_path, "rb") as f:
                self._label_encoder = pickle.load(f)

        if _HAS_ONNX and onnx_path.exists():
            opts = ort.SessionOptions()
            opts.intra_op_num_threads = 2
            self._onnx_session = ort.InferenceSession(
                str(onnx_path), sess_options=opts,
                providers=["CPUExecutionProvider"],
            )
            self._source = "onnx"
            print(f"  [BlockIntentClassifier] loaded ONNX model from {onnx_path}")
            return

        if pkl_path.exists():
            with open(pkl_path, "rb") as f:
                bundle = pickle.load(f)
            self._sklearn_model = bundle["model"]
            self._source = "sklearn"
            print(f"  [BlockIntentClassifier] loaded sklearn model from {pkl_path}")
            return

        warnings.warn(
            "BlockIntentClassifier: no trained model found — using heuristic fallback. "
            "Run train_models.py to generate model files.",
            stacklevel=2,
        )
        self._source = "heuristic"

    def is_trained(self) -> bool:
        return self._source in ("onnx", "sklearn")

    # ── Feature vector ────────────────────────────────────────────────────────

    def _to_vector(self, ctx: dict) -> np.ndarray:
        """Convert a block-context dict to the model input vector."""
        return np.array(
            [float(ctx.get(f, 0.0)) for f in BLOCK_CONTEXT_FEATURES],
            dtype=np.float32,
        ).reshape(1, -1)

    # ── Inference ─────────────────────────────────────────────────────────────

    def predict(self, ctx: dict) -> BlockIntentResult:
        """
        ctx: dict with keys matching BLOCK_CONTEXT_FEATURES, plus optional
             was_ever_trusted (bool acceptable, coerced to 0/1).
        """
        # Coerce boolean fields
        ctx = dict(ctx)
        for k in ("was_ever_trusted",):
            if isinstance(ctx.get(k), bool):
                ctx[k] = int(ctx[k])

        if self._source == "onnx":
            return self._predict_onnx(ctx)
        if self._source == "sklearn":
            return self._predict_sklearn(ctx)
        return self._predict_heuristic(ctx)

    def _predict_onnx(self, ctx: dict) -> BlockIntentResult:
        X = self._to_vector(ctx)
        inp_name  = self._onnx_session.get_inputs()[0].name
        out_names = [o.name for o in self._onnx_session.get_outputs()]
        outputs   = self._onnx_session.run(out_names, {inp_name: X})

        # outputs[0] = predicted class (int), outputs[1] = probabilities dict
        pred_class = int(outputs[0][0])
        proba_dict = outputs[1][0] if len(outputs) > 1 else {}

        classes = self._label_encoder.classes_ if self._label_encoder else BLOCK_INTENT_LABEL_NAMES
        proba   = np.array([proba_dict.get(i, 0.0) for i in range(len(classes))], dtype=float)
        if proba.sum() == 0:
            proba = np.ones(len(classes)) / len(classes)
        else:
            proba /= proba.sum()

        label = classes[pred_class] if pred_class < len(classes) else "spam_block"
        return self._build_result(label, proba, classes, "onnx")

    def _predict_sklearn(self, ctx: dict) -> BlockIntentResult:
        X      = self._to_vector(ctx)
        pred   = self._sklearn_model.predict(X)[0]
        proba  = self._sklearn_model.predict_proba(X)[0]
        classes = (
            self._label_encoder.classes_
            if self._label_encoder is not None
            else np.array(BLOCK_INTENT_LABEL_NAMES)
        )
        label = classes[pred] if isinstance(pred, (int, np.integer)) else str(pred)
        return self._build_result(label, proba, classes, "sklearn")

    def _predict_heuristic(self, ctx: dict) -> BlockIntentResult:
        """
        Mirror of the TypeScript heuristicClassify() in blockIntent.ts.
        Used when no trained model is available.
        """
        log_spam = 0.0
        log_har  = 0.0

        cbb = ctx.get("calls_before_block", 0)
        if cbb == 0:
            log_spam += 3.0
        elif cbb <= 2:
            log_spam += 2.0
        elif cbb >= 10:
            log_spam -= 2.5

        abb = ctx.get("answered_before_block", 0)
        if abb == 0 and cbb >= 2:
            log_spam += 1.5; log_har += 1.0
        elif abb >= 5:
            log_spam -= 2.0

        if ctx.get("was_ever_trusted", 0):
            log_spam -= 3.0; log_har -= 1.0

        bsh = ctx.get("block_speed_hours", 9999)
        if cbb > 0 and bsh < 2:
            log_spam += 2.5
        elif bsh > 720:
            log_spam -= 1.5

        days = max(1.0, ctx.get("days_known_before_block", 1))
        cpd  = cbb / days
        if cpd >= 4 and cbb >= 6:
            log_har += 2.5
        elif cpd >= 2 and cbb >= 4:
            log_har += 1.0

        adb = ctx.get("avg_duration_before_block", 0)
        if 0 < adb < 15:
            log_spam += 1.5
        elif adb >= 60:
            log_spam -= 1.0

        mcc = ctx.get("mutual_call_count", 0)
        if mcc >= 3:
            log_spam -= 2.5
        elif mcc == 0 and cbb >= 3:
            log_spam += 0.8

        if ctx.get("callee_block_propensity", 0) >= 0.4:
            log_spam -= 1.5

        bc24 = ctx.get("block_cluster_24h", 0)
        if bc24 >= 5:
            log_spam += 3.5; log_har += 1.0
        elif bc24 >= 2:
            log_spam += 1.5

        e_p = np.exp(0)
        e_s = np.exp(min(log_spam, 8))
        e_h = np.exp(min(log_har,  8))
        total = e_p + e_s + e_h
        proba = np.array([e_p / total, e_s / total, e_h / total])

        classes = np.array(["personal_dispute", "spam_block", "harassment_block"])
        idx   = int(np.argmax(proba))
        label = classes[idx]
        return self._build_result(label, proba, classes, "heuristic")

    # ── Result builder ────────────────────────────────────────────────────────

    @staticmethod
    def _build_result(
        label: str,
        proba: np.ndarray,
        classes: np.ndarray,
        source: str,
    ) -> BlockIntentResult:
        label_to_idx = {c: i for i, c in enumerate(classes)}

        def p(name: str) -> float:
            return float(proba[label_to_idx[name]]) if name in label_to_idx else 0.0

        weight = INTENT_WEIGHT.get(label, 1.0)

        # Blend toward spam_block when uncertain (entropy-based, matches TS logic)
        entropy     = -sum(float(q) * np.log(float(q) + 1e-9) for q in proba)
        max_entropy = np.log(len(proba))
        certainty   = 1 - entropy / max_entropy if max_entropy > 0 else 1.0
        weight = certainty * weight + (1 - certainty) * INTENT_WEIGHT["spam_block"]
        weight = round(weight, 2)

        return BlockIntentResult(
            label        = label,
            p_personal   = p("personal_dispute"),
            p_spam       = p("spam_block"),
            p_harassment = p("harassment_block"),
            weight       = weight,
            penalty_pts  = round(BASE_BLOCK_PTS * weight, 1),
            confidence   = float(max(proba)),
            source       = source,
        )
