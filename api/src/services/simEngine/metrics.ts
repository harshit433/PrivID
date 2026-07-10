/**
 * Time-series simulation — live metrics + final evaluation.
 *
 * Maintains the latest per-account state and a per-virtual-day timeline, and
 * derives the detection/false-positive/time-to-detection numbers that both the
 * live SSE dashboard and the final report consume.
 */

import type { RecomputeResult } from './recompute';
import type { SimAccount, Persona } from './personas';
import { PERSONA_BASE } from './personas';

interface UserState {
  persona: Persona; isBad: boolean;
  score: number; tier: string; prediction: string; underReview: boolean;
  firstFlagDay: number | null;
}

const TIERS = ['anonymous', 'basic', 'verified', 'premium'] as const;

export class SimMetrics {
  private users = new Map<string, UserState>();
  timeline: Array<Record<string, unknown>> = [];
  totalCalls = 0;
  totalBlocks = 0;

  constructor(accounts: SimAccount[]) {
    for (const a of accounts) {
      this.users.set(a.user_id, {
        persona: a.persona, isBad: a.isBad, score: a.base_score,
        tier: 'anonymous', prediction: 'unknown', underReview: false, firstFlagDay: null,
      });
    }
  }

  update(day: number, results: RecomputeResult[]): void {
    for (const r of results) {
      const u = this.users.get(r.user_id);
      if (!u) continue;
      u.score = r.score; u.tier = r.tier; u.prediction = r.persona_prediction;
      u.underReview = r.under_review;
      if (r.newly_flagged && u.firstFlagDay === null) u.firstFlagDay = day;
    }
  }

  /** Compact snapshot for the live SSE stream. */
  snapshot(day: number, virtualDay: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const perPersona: Record<string, { mean: number; n: number }> = {};
    const tiers: Record<string, number> = { anonymous: 0, basic: 0, verified: 0, premium: 0 };
    let badTotal = 0, badDetected = 0, goodTotal = 0, fp = 0, underReview = 0;

    for (const u of this.users.values()) {
      (perPersona[u.persona] ??= { mean: 0, n: 0 });
      perPersona[u.persona].mean += u.score; perPersona[u.persona].n++;
      tiers[u.tier] = (tiers[u.tier] ?? 0) + 1;
      if (u.underReview) underReview++;
      const flagged = u.underReview || u.score < 20;
      if (u.isBad) { badTotal++; if (flagged) badDetected++; }
      else { goodTotal++; if (u.underReview) fp++; }
    }
    const means: Record<string, number> = {};
    for (const [p, v] of Object.entries(perPersona)) means[p] = Math.round((v.mean / v.n) * 10) / 10;

    return {
      day: virtualDay, step_day: day,
      persona_means: means, tiers,
      detection_rate: badTotal ? Math.round((badDetected / badTotal) * 100) : 0,
      false_positive_rate: goodTotal ? Math.round((fp / goodTotal) * 100) : 0,
      under_review: underReview, bad_total: badTotal, bad_detected: badDetected,
      good_total: goodTotal, false_positives: fp,
      total_calls: this.totalCalls, total_blocks: this.totalBlocks,
      ...extra,
    };
  }

  recordTimeline(day: number): void {
    this.timeline.push(this.snapshot(day, day));
  }

  /** Full evaluation report. */
  final(): Record<string, unknown> {
    const personas = Object.keys(PERSONA_BASE) as Persona[];
    const perPersona: Record<string, unknown> = {};
    const confusion: Record<string, Record<string, number>> = {};

    for (const p of personas) {
      const members = [...this.users.values()].filter(u => u.persona === p);
      if (!members.length) continue;
      const scores = members.map(m => m.score);
      const flagged = members.filter(m => m.underReview || m.score < 20).length;
      const reviewed = members.filter(m => m.underReview).length;
      const detectDays = members.filter(m => m.firstFlagDay !== null).map(m => m.firstFlagDay as number);
      perPersona[p] = {
        n: members.length,
        is_bad: PERSONA_BASE[p].isBad,
        mean_score: round(avg(scores)),
        min_score: Math.min(...scores), max_score: Math.max(...scores),
        flagged, flagged_pct: pct(flagged, members.length),
        under_review: reviewed,
        median_time_to_detection_days: detectDays.length ? round(median(detectDays)) : null,
        detection_rate_pct: PERSONA_BASE[p].isBad ? pct(flagged, members.length) : null,
        false_positive_pct: !PERSONA_BASE[p].isBad ? pct(reviewed, members.length) : null,
      };
      confusion[p] = {};
      for (const m of members) confusion[p][m.prediction] = (confusion[p][m.prediction] ?? 0) + 1;
    }

    const bad = [...this.users.values()].filter(u => u.isBad);
    const good = [...this.users.values()].filter(u => !u.isBad);
    const badDetected = bad.filter(u => u.underReview || u.score < 20).length;
    const fp = good.filter(u => u.underReview).length;

    return {
      summary: {
        accounts: this.users.size,
        overall_detection_rate_pct: pct(badDetected, bad.length),
        overall_false_positive_rate_pct: pct(fp, good.length),
        bad_total: bad.length, bad_detected: badDetected,
        good_total: good.length, false_positives: fp,
        total_calls: this.totalCalls, total_blocks: this.totalBlocks,
      },
      per_persona: perPersona,
      confusion_matrix: confusion,
      tier_distribution: this.snapshot(0, 0).tiers,
      timeline: this.timeline,
    };
  }
}

const avg = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const round = (x: number) => Math.round(x * 10) / 10;
const pct = (a: number, b: number) => b ? Math.round((a / b) * 100) : 0;
function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
