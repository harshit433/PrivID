"""
Feature definitions shared across training and inference.
Mirrors backend/api/src/services/featureStore.ts exactly.
Keep these two files in sync.
"""
from dataclasses import dataclass, asdict, field
from typing import Literal

# ─── All feature names in canonical order ─────────────────────────────────────
# This order is preserved in training data CSV and model input tensors.

IDENTITY_FEATURES = [
    "phone_verified",
    "device_integrity",
    "liveness_check",
    "govt_id_verified",
    "profile_completeness",
    "account_age_days",
]

VOLUME_FEATURES = [
    "calls_out_1d", "calls_out_7d", "calls_out_30d",
    "calls_in_1d",  "calls_in_7d",  "calls_in_30d",
    "unique_callees_1d", "unique_callees_7d", "unique_callees_30d",
    "unique_callers_7d",
    "calls_per_unique_callee_1d",
    "new_targets_1d",
]

QUALITY_FEATURES = [
    "answer_rate_out_1d", "answer_rate_out_7d",
    "answer_rate_in_1d",  "answer_rate_in_7d",
    "avg_call_duration_7d",
    "pct_calls_under_30s_7d",
    "reciprocal_rate_30d",
    "calls_to_trusted_ratio_7d",
]

BEHAVIORAL_FEATURES = [
    "unknown_call_ratio_7d",
    "burst_count_7d",
    "burst_acceleration",
    "repeat_call_rate_7d",
    "sequential_dialing_max",
    "first_contact_ghost_ratio_30d",
    "consistent_ignorer_count_30d",
]

NETWORK_FEATURES = [
    "trusted_contacts_count",
    "blocked_by_7d",
    "blocked_by_30d",
    "block_trusted_ratio",
    "avg_trust_of_network",
    "shared_targets_with_flagged",
]

TREND_FEATURES = [
    "score_slope_7d",
    # behavior_regime is categorical — one-hot encoded separately
    "regime_stable",
    "regime_escalating",
    "regime_declining",
    "regime_recovering",
]

# All features used by CallBehaviorClassifier (M2)
BEHAVIOR_MODEL_FEATURES = (
    VOLUME_FEATURES +
    QUALITY_FEATURES +
    BEHAVIORAL_FEATURES +
    NETWORK_FEATURES
)

# All features used by MetaEnsemble (M8)
ALL_FEATURES = (
    IDENTITY_FEATURES +
    VOLUME_FEATURES +
    QUALITY_FEATURES +
    BEHAVIORAL_FEATURES +
    NETWORK_FEATURES +
    TREND_FEATURES
)

# ─── Block context features (for BlockIntentClassifier M3) ────────────────────

BLOCK_CONTEXT_FEATURES = [
    "calls_before_block",
    "days_known_before_block",
    "was_ever_trusted",
    "block_speed_hours",
    "answered_before_block",
    "avg_duration_before_block",
    "mutual_call_count",
    "callee_block_propensity",
    "block_cluster_24h",
]

# ─── Label encodings ──────────────────────────────────────────────────────────

# CallBehaviorClassifier labels
BEHAVIOR_LABELS = {
    "normal_low":       0,
    "normal_high":      0,
    "power_user":       0,
    "private_safe":     0,
    "passive":          0,
    "personal_blocker": 0,
    "mass_spammer":     2,   # spammer
    "harasser":         3,   # harasser
    "scammer":          2,   # spammer
    "reformed":         2,
    "sleeper":          2,
}
BEHAVIOR_LABEL_NAMES = ["clean", "suspicious", "spammer", "harasser"]

# BlockIntentClassifier labels
BLOCK_INTENT_LABELS = {
    "personal_dispute": 0,
    "spam_block":       1,
    "harassment_block": 2,
}
BLOCK_INTENT_LABEL_NAMES = ["personal_dispute", "spam_block", "harassment_block"]

# ─── Feature stats for normalization (computed from training data) ────────────
# These are updated by train_models.py — do not edit by hand.

FEATURE_STATS = {}  # filled in after first training run
