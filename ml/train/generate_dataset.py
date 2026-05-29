"""
generate_dataset.py — Export labeled training data from a live DB + simulation.

Usage:
    DATABASE_URL=postgresql://... python generate_dataset.py \
        --runs 200 \
        --out-dir ./data

For each sim run:
  1. POST /simulation/big-run with a fresh seed
  2. Collect all bsim user IDs + their persona_type labels
  3. For each user, extract feature vector from DB
  4. Write to CSV: features + label

Requires: psycopg2, requests, pandas, tqdm
"""
import argparse
import json
import os
import sys
import time
import random
from pathlib import Path

import pandas as pd
import psycopg2
import psycopg2.extras
import requests
from tqdm import tqdm

# ─── Config ───────────────────────────────────────────────────────────────────

API_URL  = os.environ.get("PRIVID_API_URL", "http://localhost:3000")
SIM_KEY  = os.environ.get("SIMULATION_KEY",  "privid-sim-2024")
DB_URL   = os.environ.get("DATABASE_URL",    "postgresql://privid:privid_dev@localhost:5432/privid")

# ─── SQL: extract all features for a list of user IDs ─────────────────────────

FEATURE_SQL = """
WITH
  ids AS (SELECT unnest($1::uuid[]) AS uid),
  identity AS (
    SELECT
      u.user_id,
      EXTRACT(DAY FROM NOW() - u.created_at)::int AS account_age_days,
      (u.display_name IS NOT NULL AND u.display_name != '')::int AS has_display_name,
      (u.avatar_url IS NOT NULL)::int AS has_avatar,
      MAX(CASE WHEN tf.factor_type='phone_verified'   AND tf.status='completed' THEN 1 ELSE 0 END) AS phone_verified,
      MAX(CASE WHEN tf.factor_type='device_integrity' AND tf.status='completed' THEN 1 ELSE 0 END) AS device_integrity,
      MAX(CASE WHEN tf.factor_type='liveness_check'   AND tf.status='completed' THEN 1 ELSE 0 END) AS liveness_check,
      MAX(CASE WHEN tf.factor_type='govt_id_verified' AND tf.status='completed' THEN 1 ELSE 0 END) AS govt_id_verified
    FROM users u
    LEFT JOIN trust_factors tf ON tf.user_id = u.user_id
    WHERE u.user_id = ANY($1::uuid[])
    GROUP BY u.user_id, u.display_name, u.avatar_url, u.created_at
  ),
  calls_agg AS (
    SELECT
      uid,
      COUNT(*) FILTER (WHERE c.caller_id = uid AND c.created_at > NOW()-'1 day'::interval)   AS calls_out_1d,
      COUNT(*) FILTER (WHERE c.caller_id = uid AND c.created_at > NOW()-'7 days'::interval)  AS calls_out_7d,
      COUNT(*) FILTER (WHERE c.caller_id = uid AND c.created_at > NOW()-'30 days'::interval) AS calls_out_30d,
      COUNT(*) FILTER (WHERE c.callee_id = uid AND c.created_at > NOW()-'1 day'::interval)   AS calls_in_1d,
      COUNT(*) FILTER (WHERE c.callee_id = uid AND c.created_at > NOW()-'7 days'::interval)  AS calls_in_7d,
      COUNT(*) FILTER (WHERE c.callee_id = uid AND c.created_at > NOW()-'30 days'::interval) AS calls_in_30d,
      COUNT(DISTINCT c.callee_id) FILTER (WHERE c.caller_id = uid AND c.created_at > NOW()-'1 day'::interval)   AS unique_callees_1d,
      COUNT(DISTINCT c.callee_id) FILTER (WHERE c.caller_id = uid AND c.created_at > NOW()-'7 days'::interval)  AS unique_callees_7d,
      COUNT(DISTINCT c.callee_id) FILTER (WHERE c.caller_id = uid AND c.created_at > NOW()-'30 days'::interval) AS unique_callees_30d,
      COUNT(DISTINCT c.caller_id) FILTER (WHERE c.callee_id = uid AND c.created_at > NOW()-'7 days'::interval)  AS unique_callers_7d,
      COALESCE(AVG((c.status IN ('answered','ended'))::int) FILTER (
        WHERE c.caller_id = uid AND c.created_at > NOW()-'1 day'::interval), 0)  AS answer_rate_out_1d,
      COALESCE(AVG((c.status IN ('answered','ended'))::int) FILTER (
        WHERE c.caller_id = uid AND c.created_at > NOW()-'7 days'::interval), 0) AS answer_rate_out_7d,
      COALESCE(AVG((c.status IN ('answered','ended'))::int) FILTER (
        WHERE c.callee_id = uid AND c.created_at > NOW()-'1 day'::interval), 0)  AS answer_rate_in_1d,
      COALESCE(AVG((c.status IN ('answered','ended'))::int) FILTER (
        WHERE c.callee_id = uid AND c.created_at > NOW()-'7 days'::interval), 0) AS answer_rate_in_7d,
      COALESCE(AVG(c.duration_seconds) FILTER (
        WHERE c.caller_id = uid AND c.duration_seconds IS NOT NULL
          AND c.created_at > NOW()-'7 days'::interval), 0) AS avg_call_duration_7d,
      COALESCE(AVG((c.duration_seconds < 30)::int) FILTER (
        WHERE c.caller_id = uid AND c.duration_seconds IS NOT NULL
          AND c.created_at > NOW()-'7 days'::interval), 0) AS pct_calls_under_30s_7d
    FROM ids
    LEFT JOIN calls c ON c.caller_id = uid OR c.callee_id = uid
    WHERE c.created_at > NOW() - '30 days'::interval OR c.created_at IS NULL
    GROUP BY uid
  ),
  network_agg AS (
    SELECT
      uid,
      COUNT(*) FILTER (WHERE conn.owner_id = uid AND conn.connection_type='trusted')   AS trusted_count,
      COUNT(*) FILTER (WHERE conn.contact_id=uid AND conn.connection_type='blocked'
        AND conn.updated_at > NOW()-'7 days'::interval)  AS blocked_by_7d,
      COUNT(*) FILTER (WHERE conn.contact_id=uid AND conn.connection_type='blocked'
        AND conn.updated_at > NOW()-'30 days'::interval) AS blocked_by_30d,
      COUNT(*) FILTER (WHERE conn.owner_id=uid) AS total_connections
    FROM ids
    LEFT JOIN connections conn ON conn.owner_id = uid OR conn.contact_id = uid
    GROUP BY uid
  ),
  network_trust AS (
    SELECT c.owner_id AS uid, COALESCE(AVG(u.trust_score), 0) AS avg_net_trust
    FROM connections c
    JOIN users u ON u.user_id = c.contact_id
    WHERE c.owner_id = ANY($1::uuid[]) AND c.connection_type = 'trusted'
    GROUP BY c.owner_id
  )
SELECT
  i.user_id,
  i.phone_verified, i.device_integrity, i.liveness_check, i.govt_id_verified,
  (i.has_display_name * 0.5 + i.has_avatar * 0.5)::float AS profile_completeness,
  i.account_age_days,
  COALESCE(ca.calls_out_1d,0)      AS calls_out_1d,
  COALESCE(ca.calls_out_7d,0)      AS calls_out_7d,
  COALESCE(ca.calls_out_30d,0)     AS calls_out_30d,
  COALESCE(ca.calls_in_1d,0)       AS calls_in_1d,
  COALESCE(ca.calls_in_7d,0)       AS calls_in_7d,
  COALESCE(ca.calls_in_30d,0)      AS calls_in_30d,
  COALESCE(ca.unique_callees_1d,0) AS unique_callees_1d,
  COALESCE(ca.unique_callees_7d,0) AS unique_callees_7d,
  COALESCE(ca.unique_callees_30d,0)AS unique_callees_30d,
  COALESCE(ca.unique_callers_7d,0) AS unique_callers_7d,
  CASE WHEN COALESCE(ca.unique_callees_1d,0) > 0
    THEN ca.calls_out_1d::float / ca.unique_callees_1d ELSE 0 END AS calls_per_unique_callee_1d,
  COALESCE(ca.answer_rate_out_1d,0)  AS answer_rate_out_1d,
  COALESCE(ca.answer_rate_out_7d,0)  AS answer_rate_out_7d,
  COALESCE(ca.answer_rate_in_1d,0)   AS answer_rate_in_1d,
  COALESCE(ca.answer_rate_in_7d,0)   AS answer_rate_in_7d,
  COALESCE(ca.avg_call_duration_7d,0)AS avg_call_duration_7d,
  COALESCE(ca.pct_calls_under_30s_7d,0) AS pct_calls_under_30s_7d,
  COALESCE(na.trusted_count,0)      AS trusted_contacts_count,
  COALESCE(na.blocked_by_7d,0)      AS blocked_by_7d,
  COALESCE(na.blocked_by_30d,0)     AS blocked_by_30d,
  CASE WHEN COALESCE(na.trusted_count,0)+COALESCE(na.blocked_by_30d,0) > 0
    THEN na.blocked_by_30d::float / (na.trusted_count + na.blocked_by_30d) ELSE 0 END AS block_trusted_ratio,
  COALESCE(nt.avg_net_trust, 0)     AS avg_trust_of_network
FROM identity i
LEFT JOIN calls_agg    ca ON ca.uid = i.user_id
LEFT JOIN network_agg  na ON na.uid = i.user_id
LEFT JOIN network_trust nt ON nt.uid = i.user_id
"""

BEHAVIOR_SQL = """
WITH
  burst AS (
    SELECT caller_id AS uid,
      COUNT(*) FILTER (WHERE created_at > NOW()-'7 days'::interval) AS this_week,
      COUNT(*) FILTER (
        WHERE created_at BETWEEN NOW()-'14 days'::interval AND NOW()-'7 days'::interval
      ) AS last_week,
      COUNT(DISTINCT DATE(created_at)) FILTER (
        WHERE created_at > NOW()-'7 days'::interval
      ) AS active_days
    FROM calls WHERE caller_id = ANY($1::uuid[])
    GROUP BY caller_id
  ),
  daily_burst AS (
    SELECT caller_id AS uid, COUNT(*) AS burst_days
    FROM (
      SELECT caller_id, DATE(created_at), COUNT(*) AS daily_cnt
      FROM calls
      WHERE caller_id = ANY($1::uuid[]) AND created_at > NOW()-'7 days'::interval
      GROUP BY caller_id, DATE(created_at)
    ) sub WHERE daily_cnt > 10
    GROUP BY caller_id
  ),
  unknowns AS (
    SELECT c.caller_id AS uid,
      COUNT(*) FILTER (
        WHERE NOT EXISTS (
          SELECT 1 FROM connections cc
          WHERE cc.owner_id = c.callee_id AND cc.contact_id = c.caller_id
            AND cc.connection_type NOT IN ('unknown','blocked')
        )
      ) AS unknown_calls,
      COUNT(*) AS total_calls
    FROM calls c
    WHERE c.caller_id = ANY($1::uuid[]) AND c.created_at > NOW()-'7 days'::interval
    GROUP BY c.caller_id
  ),
  ghosted AS (
    SELECT caller_id AS uid,
      COUNT(*) FILTER (WHERE answered_count = 1) AS ghost_targets,
      COUNT(*) FILTER (WHERE answered_count = 0) AS ignorer_targets,
      COUNT(*) AS total_targets
    FROM (
      SELECT caller_id, callee_id,
        COUNT(*) FILTER (WHERE status IN ('answered','ended')) AS answered_count,
        COUNT(*) AS call_count
      FROM calls
      WHERE caller_id = ANY($1::uuid[]) AND created_at > NOW()-'30 days'::interval
      GROUP BY caller_id, callee_id
      HAVING COUNT(*) >= 2
    ) sub
    GROUP BY caller_id
  ),
  repeat_rates AS (
    SELECT caller_id AS uid,
      SUM(GREATEST(0, call_count-1)) AS repeat_calls,
      SUM(call_count) AS total_calls
    FROM (
      SELECT caller_id, callee_id, COUNT(*) AS call_count
      FROM calls
      WHERE caller_id = ANY($1::uuid[]) AND created_at > NOW()-'7 days'::interval
      GROUP BY caller_id, callee_id
    ) sub
    GROUP BY caller_id
  )
SELECT
  u.user_id,
  COALESCE(b.this_week, 0) AS this_week_calls,
  COALESCE(b.last_week, 0) AS last_week_calls,
  CASE WHEN COALESCE(b.last_week,0) > 0
    THEN b.this_week::float / b.last_week ELSE
    CASE WHEN COALESCE(b.this_week,0) > 0 THEN 5 ELSE 1 END
  END AS burst_acceleration,
  COALESCE(db.burst_days, 0) AS burst_count_7d,
  CASE WHEN COALESCE(u2.total_calls,0) > 0
    THEN u2.unknown_calls::float / u2.total_calls ELSE 0 END AS unknown_call_ratio_7d,
  CASE WHEN COALESCE(g.total_targets,0) > 0
    THEN g.ghost_targets::float / g.total_targets ELSE 0 END AS first_contact_ghost_ratio_30d,
  COALESCE(g.ignorer_targets, 0) AS consistent_ignorer_count_30d,
  CASE WHEN COALESCE(r.total_calls,0) > 0
    THEN r.repeat_calls::float / r.total_calls ELSE 0 END AS repeat_call_rate_7d
FROM (SELECT unnest($1::uuid[]) AS user_id) u
LEFT JOIN burst         b  ON b.uid  = u.user_id
LEFT JOIN daily_burst   db ON db.uid = u.user_id
LEFT JOIN unknowns      u2 ON u2.uid = u.user_id
LEFT JOIN ghosted       g  ON g.uid  = u.user_id
LEFT JOIN repeat_rates  r  ON r.uid  = u.user_id
"""

# ─── Main ─────────────────────────────────────────────────────────────────────

def run_big_sim(seed: int, api_url: str, sim_key: str) -> dict:
    r = requests.post(
        f"{api_url}/simulation/big-run",
        json={"sim_key": sim_key, "seed": seed},
        timeout=300,
    )
    r.raise_for_status()
    data = r.json()
    if not data.get("ok"):
        raise RuntimeError(f"big-run failed: {data}")
    return data["data"]


def fetch_features_for_users(conn, user_ids: list[str]) -> pd.DataFrame:
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(FEATURE_SQL, (user_ids,))
    base = pd.DataFrame(cur.fetchall())
    cur.execute(BEHAVIOR_SQL, (user_ids,))
    behav = pd.DataFrame(cur.fetchall())
    if base.empty:
        return base
    merged = base.merge(behav, on="user_id", how="left")
    return merged.fillna(0)


def generate(num_runs: int, out_dir: Path, api_url: str, sim_key: str, db_url: str):
    out_dir.mkdir(parents=True, exist_ok=True)
    conn = psycopg2.connect(db_url)

    all_rows = []
    block_rows = []
    seeds = list(range(1, num_runs + 1))

    for seed in tqdm(seeds, desc="Simulations"):
        try:
            result = run_big_sim(seed, api_url, sim_key)
        except Exception as e:
            print(f"  seed {seed} failed: {e}", file=sys.stderr)
            continue

        # Build label map from user_logs
        label_map = {
            log["user_id"]: log["persona_type"]
            for log in result["user_logs"]
        }
        review_map = {
            log["user_id"]: log["is_under_review"]
            for log in result["user_logs"]
        }

        user_ids = list(label_map.keys())
        try:
            features_df = fetch_features_for_users(conn, user_ids)
        except Exception as e:
            print(f"  seed {seed} feature fetch failed: {e}", file=sys.stderr)
            continue

        features_df["persona_type"]    = features_df["user_id"].map(label_map)
        features_df["is_under_review"] = features_df["user_id"].map(review_map)
        features_df["seed"]            = seed
        all_rows.append(features_df)

        # Collect block contexts for block intent training
        # (block_cluster_24h approximated from review state)
        for uid, ptype in label_map.items():
            if ptype in ("mass_spammer", "scammer", "harasser"):
                intent = "spam_block" if ptype != "harasser" else "harassment_block"
                block_rows.append({
                    "blocked_id": uid,
                    "persona_type": ptype,
                    "block_intent_label": intent,
                    "seed": seed,
                })

        time.sleep(0.2)  # be kind to the DB

    if not all_rows:
        print("No data collected.", file=sys.stderr)
        return

    full_df = pd.concat(all_rows, ignore_index=True)
    full_df.to_csv(out_dir / "behavior_features.csv", index=False)
    print(f"\n✓ Wrote {len(full_df)} rows → {out_dir}/behavior_features.csv")

    if block_rows:
        pd.DataFrame(block_rows).to_csv(out_dir / "block_intent_labels.csv", index=False)
        print(f"✓ Wrote {len(block_rows)} block intent labels → {out_dir}/block_intent_labels.csv")

    conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs",    type=int, default=50,    help="Number of simulation runs")
    parser.add_argument("--out-dir", type=str, default="data", help="Output directory")
    parser.add_argument("--api-url", type=str, default=API_URL)
    parser.add_argument("--sim-key", type=str, default=SIM_KEY)
    parser.add_argument("--db-url",  type=str, default=DB_URL)
    args = parser.parse_args()

    generate(
        num_runs=args.runs,
        out_dir=Path(args.out_dir),
        api_url=args.api_url,
        sim_key=args.sim_key,
        db_url=args.db_url,
    )
