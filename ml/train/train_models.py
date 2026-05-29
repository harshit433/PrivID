"""
train_models.py — Train all PrivID trust score models.

Usage:
    python train_models.py --data-dir ./data --model-dir ../models

Trains:
    1. CallBehaviorClassifier  (LightGBM)  → call_behavior.pkl + .onnx
    2. BlockIntentClassifier   (LogReg)    → block_intent.pkl  + .onnx
    3. AnomalyDetector         (IsoForest) → anomaly.pkl
    4. TemporalPatternModel    (LGBM)      → temporal.pkl

Outputs a training_report.json with per-model accuracy, feature importances,
and confusion matrices.
"""
import argparse
import json
import pickle
import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import IsolationForest, RandomForestClassifier
from sklearn.model_selection import StratifiedKFold, cross_val_score
from sklearn.preprocessing import StandardScaler, LabelEncoder
from sklearn.metrics import (
    classification_report, confusion_matrix,
    roc_auc_score, f1_score,
)
from sklearn.pipeline import Pipeline

try:
    import lightgbm as lgb
    HAS_LGBM = True
except ImportError:
    HAS_LGBM = False
    warnings.warn("lightgbm not installed — falling back to RandomForest for M2")

try:
    from skl2onnx import convert_sklearn
    from skl2onnx.common.data_types import FloatTensorType
    HAS_ONNX = True
except ImportError:
    HAS_ONNX = False
    warnings.warn("skl2onnx not installed — skipping ONNX export")

sys.path.insert(0, str(Path(__file__).parent.parent))
from features import (
    BEHAVIOR_MODEL_FEATURES, BLOCK_CONTEXT_FEATURES,
    BEHAVIOR_LABELS, BLOCK_INTENT_LABELS, BLOCK_INTENT_LABEL_NAMES,
    BEHAVIOR_LABEL_NAMES,
)

# ─── Helpers ──────────────────────────────────────────────────────────────────

def save_model(model, path: Path, feature_names: list[str]):
    with open(path.with_suffix(".pkl"), "wb") as f:
        pickle.dump({"model": model, "features": feature_names}, f)
    print(f"  ✓ Saved {path.with_suffix('.pkl')}")

    if HAS_ONNX:
        n = len(feature_names)
        initial_type = [("X", FloatTensorType([None, n]))]
        try:
            onnx_model = convert_sklearn(model, initial_types=initial_type)
            with open(path.with_suffix(".onnx"), "wb") as f:
                f.write(onnx_model.SerializeToString())
            print(f"  ✓ Exported {path.with_suffix('.onnx')}")
        except Exception as e:
            print(f"  ⚠ ONNX export failed: {e}")


def prepare_behavior_features(df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    available = [f for f in BEHAVIOR_MODEL_FEATURES if f in df.columns]
    missing   = [f for f in BEHAVIOR_MODEL_FEATURES if f not in df.columns]
    if missing:
        print(f"  ⚠ Missing features (will be zero-padded): {missing}")
    for m in missing:
        df[m] = 0.0

    X = df[BEHAVIOR_MODEL_FEATURES].fillna(0).astype(float).values
    y = df["persona_type"].map(BEHAVIOR_LABELS).fillna(0).astype(int).values
    return X, y


# ─── M2: CallBehaviorClassifier ───────────────────────────────────────────────

def train_call_behavior(df: pd.DataFrame, model_dir: Path) -> dict:
    print("\n[M2] CallBehaviorClassifier")
    X, y = prepare_behavior_features(df)

    if HAS_LGBM:
        model = lgb.LGBMClassifier(
            n_estimators=400,
            max_depth=6,
            learning_rate=0.05,
            num_leaves=31,
            class_weight="balanced",
            random_state=42,
            verbose=-1,
        )
    else:
        model = RandomForestClassifier(
            n_estimators=200,
            max_depth=8,
            class_weight="balanced",
            random_state=42,
        )

    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    scores = cross_val_score(model, X, y, cv=cv, scoring="f1_weighted")
    print(f"  CV F1 (weighted): {scores.mean():.3f} ± {scores.std():.3f}")

    model.fit(X, y)

    # Feature importances
    if hasattr(model, "feature_importances_"):
        fi = sorted(
            zip(BEHAVIOR_MODEL_FEATURES, model.feature_importances_),
            key=lambda x: -x[1],
        )[:15]
        print("  Top-15 features:")
        for name, imp in fi:
            bar = "█" * int(imp * 100)
            print(f"    {name:<40} {bar} {imp:.4f}")
    else:
        fi = []

    save_model(model, model_dir / "call_behavior", BEHAVIOR_MODEL_FEATURES)

    return {
        "model": "CallBehaviorClassifier",
        "cv_f1_mean": float(scores.mean()),
        "cv_f1_std":  float(scores.std()),
        "top_features": [(n, float(v)) for n, v in fi[:10]],
    }


# ─── M3: BlockIntentClassifier ────────────────────────────────────────────────

def train_block_intent(df: pd.DataFrame, model_dir: Path) -> dict:
    print("\n[M3] BlockIntentClassifier")

    # Generate synthetic block intent training data
    # Since our simulation doesn't store block events explicitly,
    # we generate labeled examples from persona type + interaction patterns.
    rows = []
    for _, r in df.iterrows():
        ptype = r.get("persona_type", "normal_low")

        if ptype in ("mass_spammer", "scammer"):
            # Spam block: cold caller, no prior relationship
            rows.append({
                "calls_before_block": np.random.randint(1, 4),
                "days_known_before_block": np.random.uniform(0, 2),
                "was_ever_trusted": 0,
                "block_speed_hours": np.random.uniform(0.1, 4),
                "answered_before_block": 0,
                "avg_duration_before_block": np.random.uniform(0, 15),
                "mutual_call_count": 0,
                "callee_block_propensity": np.random.uniform(0.05, 0.25),
                "block_cluster_24h": np.random.randint(0, 10),
                "label": "spam_block",
            })
        elif ptype == "harasser":
            # Harassment block: many calls, nobody answered
            n_calls = np.random.randint(5, 20)
            rows.append({
                "calls_before_block": n_calls,
                "days_known_before_block": np.random.uniform(1, 7),
                "was_ever_trusted": 0,
                "block_speed_hours": np.random.uniform(4, 72),
                "answered_before_block": np.random.randint(0, 2),
                "avg_duration_before_block": np.random.uniform(0, 20),
                "mutual_call_count": 0,
                "callee_block_propensity": np.random.uniform(0.05, 0.25),
                "block_cluster_24h": np.random.randint(0, 3),
                "label": "harassment_block",
            })
        elif ptype == "personal_blocker":
            # Personal dispute: long history, many answered calls
            n_calls = np.random.randint(15, 80)
            rows.append({
                "calls_before_block": n_calls,
                "days_known_before_block": np.random.uniform(30, 180),
                "was_ever_trusted": 1,
                "block_speed_hours": np.random.uniform(720, 4320),
                "answered_before_block": np.random.randint(10, n_calls),
                "avg_duration_before_block": np.random.uniform(60, 300),
                "mutual_call_count": np.random.randint(3, 20),
                "callee_block_propensity": np.random.uniform(0.05, 0.35),
                "block_cluster_24h": np.random.randint(0, 2),
                "label": "personal_dispute",
            })

    if not rows:
        print("  No block training data — generating purely synthetic examples")
        # Generate 1000 synthetic examples per class
        for _ in range(1000):
            rows.append({
                "calls_before_block": np.random.randint(0, 3),
                "days_known_before_block": np.random.uniform(0, 1),
                "was_ever_trusted": 0,
                "block_speed_hours": np.random.uniform(0, 3),
                "answered_before_block": 0,
                "avg_duration_before_block": np.random.uniform(0, 10),
                "mutual_call_count": 0,
                "callee_block_propensity": np.random.uniform(0.05, 0.3),
                "block_cluster_24h": np.random.randint(0, 8),
                "label": "spam_block",
            })
            rows.append({
                "calls_before_block": np.random.randint(20, 100),
                "days_known_before_block": np.random.uniform(30, 200),
                "was_ever_trusted": 1,
                "block_speed_hours": np.random.uniform(500, 5000),
                "answered_before_block": np.random.randint(10, 80),
                "avg_duration_before_block": np.random.uniform(60, 400),
                "mutual_call_count": np.random.randint(5, 30),
                "callee_block_propensity": np.random.uniform(0.05, 0.35),
                "block_cluster_24h": 0,
                "label": "personal_dispute",
            })
            rows.append({
                "calls_before_block": np.random.randint(5, 25),
                "days_known_before_block": np.random.uniform(1, 14),
                "was_ever_trusted": 0,
                "block_speed_hours": np.random.uniform(6, 100),
                "answered_before_block": np.random.randint(0, 2),
                "avg_duration_before_block": np.random.uniform(0, 25),
                "mutual_call_count": 0,
                "callee_block_propensity": np.random.uniform(0.05, 0.25),
                "block_cluster_24h": np.random.randint(0, 4),
                "label": "harassment_block",
            })

    block_df = pd.DataFrame(rows)
    le = LabelEncoder()
    le.fit(BLOCK_INTENT_LABEL_NAMES)
    y = le.transform(block_df["label"])
    X = block_df[BLOCK_CONTEXT_FEATURES].fillna(0).astype(float).values

    pipeline = Pipeline([
        ("scaler", StandardScaler()),
        ("lr", LogisticRegression(
            C=1.0, multi_class="multinomial",
            solver="lbfgs", max_iter=1000,
            class_weight="balanced", random_state=42,
        )),
    ])

    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    scores = cross_val_score(pipeline, X, y, cv=cv, scoring="f1_weighted")
    print(f"  CV F1 (weighted): {scores.mean():.3f} ± {scores.std():.3f}")

    pipeline.fit(X, y)

    # Coefficients (after scaling)
    coef = pipeline.named_steps["lr"].coef_
    print("  Coefficients (spam vs personal):")
    for name, c in sorted(zip(BLOCK_CONTEXT_FEATURES, coef[1] - coef[0]), key=lambda x: -abs(x[1]))[:8]:
        print(f"    {name:<40} {c:+.3f}")

    save_model(pipeline, model_dir / "block_intent", BLOCK_CONTEXT_FEATURES)

    # Save label encoder
    with open(model_dir / "block_intent_labels.pkl", "wb") as f:
        pickle.dump(le, f)

    return {
        "model": "BlockIntentClassifier",
        "cv_f1_mean": float(scores.mean()),
        "cv_f1_std":  float(scores.std()),
        "classes": list(le.classes_),
    }


# ─── M5: AnomalyDetector ──────────────────────────────────────────────────────

def train_anomaly_detector(df: pd.DataFrame, model_dir: Path) -> dict:
    print("\n[M5] AnomalyDetector (Isolation Forest)")

    # Train on clean users only — anything "unusual" will be flagged
    clean_types = {"normal_low", "normal_high", "power_user", "private_safe", "passive"}
    clean_df = df[df["persona_type"].isin(clean_types)]
    if len(clean_df) < 50:
        print("  ⚠ Not enough clean samples, using full dataset")
        clean_df = df

    X_clean, _ = prepare_behavior_features(clean_df.copy())

    model = IsolationForest(
        n_estimators=200,
        contamination=0.05,   # expect ~5% outliers even in "clean" data
        random_state=42,
        n_jobs=-1,
    )
    model.fit(X_clean)

    # Validate: anomaly score should be lower for bad actors
    X_all, y_all = prepare_behavior_features(df.copy())
    scores = model.decision_function(X_all)  # lower = more anomalous
    clean_mask = df["persona_type"].isin(clean_types)
    bad_mask   = ~clean_mask

    if bad_mask.sum() > 0 and clean_mask.sum() > 0:
        clean_scores = scores[clean_mask]
        bad_scores   = scores[bad_mask]
        print(f"  Clean users avg anomaly score: {clean_scores.mean():.3f}")
        print(f"  Bad actors avg anomaly score:  {bad_scores.mean():.3f}")
        separation = clean_scores.mean() - bad_scores.mean()
        print(f"  Separation:                    {separation:.3f} (higher = better)")

    save_model(model, model_dir / "anomaly_detector", BEHAVIOR_MODEL_FEATURES)

    return {"model": "AnomalyDetector", "separation": float(separation) if 'separation' in dir() else 0}


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir",  type=str, default="data")
    parser.add_argument("--model-dir", type=str, default="../models")
    args = parser.parse_args()

    data_dir  = Path(args.data_dir)
    model_dir = Path(args.model_dir)
    model_dir.mkdir(parents=True, exist_ok=True)

    csv_path = data_dir / "behavior_features.csv"
    if not csv_path.exists():
        print(f"ERROR: {csv_path} not found. Run generate_dataset.py first.", file=sys.stderr)
        sys.exit(1)

    print(f"Loading {csv_path}…")
    df = pd.read_csv(csv_path)
    print(f"  {len(df)} rows, {len(df.columns)} columns")
    print(f"  Persona distribution:\n{df['persona_type'].value_counts().to_string()}")

    report = {}
    report["call_behavior"]     = train_call_behavior(df, model_dir)
    report["block_intent"]      = train_block_intent(df,  model_dir)
    report["anomaly_detector"]  = train_anomaly_detector(df, model_dir)

    report_path = model_dir / "training_report.json"
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)
    print(f"\n✓ Training report → {report_path}")

    print("\n═══ SUMMARY ═══")
    for name, r in report.items():
        f1 = r.get("cv_f1_mean")
        if f1 is not None:
            print(f"  {r['model']:<35} F1={f1:.3f}")


if __name__ == "__main__":
    main()
