/**
 * Simulation service — orchestrates the dev-only trust/shadow simulator. Trust is
 * recomputed inline (immediate, deterministic); shadow-trust is handed to the worker's
 * shadow-recompute job (keyed by phone hash, so the `tsim_` guard doesn't apply). A run
 * = seed → generate calls/blocks → recompute → shadow.
 */
import { enqueue } from '@trustroute/core';
import * as repo from './simulation.repository';

export async function setup(input: { count: number; seed: number; spammerRatio: number }) {
  const seeded = await repo.seed(input.count, input.seed, input.spammerRatio);
  return { seeded, seed: input.seed };
}

export async function generate(seed: number) {
  return repo.generateCalls(seed);
}

export async function recompute() {
  const trust = await repo.recomputeTrust();
  // Shadow reputation is population-independent; let the worker crunch it.
  await enqueue('shadow-recompute', {}, { jobId: `sim-shadow-${Date.now()}` }).catch(() => {});
  return { ...trust, shadowRecomputeEnqueued: true };
}

/** One-shot full run for convenience: seed → generate → recompute. */
export async function run(input: { count: number; seed: number; spammerRatio: number }) {
  const seeded = await repo.seed(input.count, input.seed, input.spammerRatio);
  const activity = await repo.generateCalls(input.seed);
  const trust = await repo.recomputeTrust();
  await enqueue('shadow-recompute', {}, { jobId: `sim-shadow-${Date.now()}` }).catch(() => {});
  return { seeded, activity, trust };
}

export async function state() {
  return repo.metrics();
}

export async function teardown() {
  return repo.teardown();
}
