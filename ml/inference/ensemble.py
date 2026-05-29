"""
ensemble.py — Trust Score Meta-Ensemble (M8).

Combines outputs from all sub-models into a final trust score modifier
that augments (or overrides) the rule-based score from trustScore.ts.

Architecture:
  M2 (CallBehaviorClassifier)  → behavior label + modifier
  M3 (BlockIntentClassifier)   → per-block penalty (called separately per block)
  M5 (AnomalyDetector)         → anomaly flag + score
  M8 (TrustScoreEnsemble)      → this file: combines into final delta

Output:
  - ml_score_delta      : float  [-40, +10] added on top of rule-based score
  - ml_flags            : list[str]  human-readable signals
  - model_agreement     : float  0–1, how aligned the models are
  - override_review     : bool   force-trigger review regardless of rule-based score
  - persona_prediction  : str    predicted persona class

Design principle:
  The ensemble DOES NOT replace the rule-based score — it produces a delta.
  Positive delta = ML sees patterns the rules miss (e.g. a reformed spammer
  whose score should recover faster). Negative delta = ML sees risk the rules
  miss (e.g. a sleeper account with low volume but anomalous network patterns).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .block_intent  import BlockIntentResult
    from .call_behavior import CallBehaviorResult
    from .anomaly       import AnomalyResult


@dataclass
class EnsembleResult:
    ml_score_delta:    float           # additive modifier to rule-based score
    ml_flags:          list[str] = field(default_factory=list)
    model_agreement:   float = 1.0    # 0=conflicting, 1=all agree
    override_review:   bool = False   # force is_under_review = true
    persona_prediction: str = "clean" # predicted behavior class
    confidence:        float = 0.0


class TrustScoreEnsemble:
    """
    Stateless combiner — no model weights to load.
    Combines sub-model results using calibrated heuristics that we'll
    replace with a trained meta-learner once we have enough real data.
    """

    def combine(
        self,
        behavior: "CallBehaviorResult",
        anomaly:  "AnomalyResult",
        user_features: dict,
    ) -> EnsembleResult:
        """
        Combine sub-model outputs into a trust score delta.

        block_intent results are NOT passed here — they're applied per-block
        in getStaticBehaviorPenalty() and accumulated separately.
        """
        flags: list[str] = []
        delta = 0.0

        # ── M2: Behavior classifier signal ────────────────────────────────────
        behavior_delta = self._behavior_delta(behavior, flags)
        delta += behavior_delta

        # ── M5: Anomaly signal ────────────────────────────────────────────────
        anomaly_delta = self._anomaly_delta(anomaly, flags)
        delta += anomaly_delta

        # ── Cross-model consistency ───────────────────────────────────────────
        agreement, consensus_delta = self._consensus(behavior, anomaly, flags)
        delta += consensus_delta

        # ── Clamp ─────────────────────────────────────────────────────────────
        delta = max(-40.0, min(10.0, delta))

        # ── Override review trigger ───────────────────────────────────────────
        override_review = (
            behavior.label in ("spammer", "harasser") and behavior.confidence > 0.75
            and anomaly.is_anomaly
        )
        if override_review:
            flags.append("⚠ ML consensus: forced review trigger (high-confidence anomalous bad actor)")

        return EnsembleResult(
            ml_score_delta    = round(delta, 1),
            ml_flags          = flags,
            model_agreement   = round(agreement, 2),
            override_review   = override_review,
            persona_prediction= behavior.label,
            confidence        = round(behavior.confidence, 2),
        )

    # ── Sub-model delta calculators ───────────────────────────────────────────

    @staticmethod
    def _behavior_delta(behavior: "CallBehaviorResult", flags: list[str]) -> float:
        """
        Convert behavior classifier output to a score delta.

        clean:       0        (no modifier)
        suspicious:  -3       (mild warning)
        spammer:     -8 to -15 (scaled by confidence)
        harasser:    -10 to -20 (scaled by confidence)
        """
        label = behavior.label
        conf  = behavior.confidence

        if label == "clean":
            # Reward very clean users slightly
            if conf > 0.9:
                flags.append("ML confirms clean calling behavior")
                return +2.0
            return 0.0

        if label == "suspicious":
            flags.append(f"ML flagged suspicious behavior (confidence {conf:.0%})")
            return -3.0 * conf

        if label == "spammer":
            pen = -(8.0 + 7.0 * conf)   # -8 to -15
            flags.append(f"ML classified as spammer (confidence {conf:.0%}) → {pen:.1f} pts")
            for sig in behavior.spam_signals[:3]:
                flags.append(f"  · {sig}")
            return pen

        if label == "harasser":
            pen = -(10.0 + 10.0 * conf)  # -10 to -20
            flags.append(f"ML classified as harasser (confidence {conf:.0%}) → {pen:.1f} pts")
            for sig in behavior.harasser_signals[:3]:
                flags.append(f"  · {sig}")
            return pen

        return 0.0

    @staticmethod
    def _anomaly_delta(anomaly: "AnomalyResult", flags: list[str]) -> float:
        """
        Anomaly score penalty — only applied when meaningfully anomalous.
        The isolation forest scores clean users near 0; truly unusual patterns
        get a proportional penalty.
        """
        if not anomaly.is_anomaly:
            return 0.0

        norm = anomaly.normalized   # 0–1, higher = more anomalous
        pen  = -(norm * 8.0)        # up to -8 pts for extreme anomalies

        flags.append(
            f"Anomaly detector flagged unusual pattern "
            f"(score={anomaly.anomaly_score:.3f}, severity={norm:.0%}) → {pen:.1f} pts"
        )
        return pen

    @staticmethod
    def _consensus(
        behavior: "CallBehaviorResult",
        anomaly:  "AnomalyResult",
        flags:    list[str],
    ) -> tuple[float, float]:
        """
        Cross-model agreement score and consensus delta.

        Agreement is high when:
          - behavior = spammer/harasser AND anomaly = True     (double confirm)
          - behavior = clean AND anomaly = False               (double clean)

        Conflict when:
          - behavior = clean but anomaly = True               (trust anomaly less)
          - behavior = spammer but anomaly = False            (trust behavior less)
        """
        bad_behavior = behavior.label in ("spammer", "harasser")
        is_anomaly   = anomaly.is_anomaly

        if bad_behavior and is_anomaly:
            # Both models agree this is a problem — amplify
            agreement = 0.9 + 0.1 * behavior.confidence
            flags.append("Both behavior and anomaly models agree: high-risk user")
            return agreement, -5.0   # extra consensus penalty

        if not bad_behavior and not is_anomaly:
            # Both models agree this is clean
            agreement = 0.9
            return agreement, 0.0

        if bad_behavior and not is_anomaly:
            # Behavior says bad, anomaly says normal — partial confidence
            flags.append("Note: behavior classifier flags risk but anomaly detector disagrees")
            return 0.5, 0.0

        # Behavior says clean, anomaly says unusual — something novel
        if is_anomaly:
            flags.append("Anomaly detected in otherwise clean-looking user — possible sleeper/emerging pattern")
            return 0.5, -2.0

        return 1.0, 0.0
