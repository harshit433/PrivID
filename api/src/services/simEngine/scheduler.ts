/**
 * Time-series simulation — orchestrator.
 *
 * Owns the single active run: seeds the population, advances a virtual clock over
 * `virtual_days` compressed into `wall_minutes`, generates event windows, recomputes
 * trust as-of virtual time through the real ML pipeline, and emits live snapshots.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { Rng } from './rng';
import { buildAccounts, type SimAccount } from './personas';
import { buildGraph, seedDatabase, type SimGraph } from './graph';
import { initState, generateWindow, persistWindow, type SimState } from './events';
import { recomputeAsOf } from './recompute';
import { SimMetrics } from './metrics';
import { teardownSim } from './teardown';

export interface RunParams {
  accounts: number;
  virtual_days: number;
  wall_minutes: number;
  step_hours: number;
  recompute_every_hours: number;
  seed: number;
  keep_data: boolean;
}

export const DEFAULT_PARAMS: RunParams = {
  accounts: 500, virtual_days: 30, wall_minutes: 10,
  step_hours: 2, recompute_every_hours: 6, seed: Date.now() % 100000, keep_data: false,
};

type Status = 'seeding' | 'running' | 'recomputing' | 'done' | 'error' | 'stopped';

interface RunState {
  run_id: string;
  status: Status;
  params: RunParams;
  started_at: string;
  virtual_day: number;
  progress: number;          // 0..1
  error: string | null;
  last_snapshot: Record<string, unknown> | null;
  metrics: SimMetrics | null;
  emitter: EventEmitter;
  stopFlag: boolean;
}

let current: RunState | null = null;

export function getRun(): RunState | null { return current; }
export function stopRun(): boolean {
  if (current && (current.status === 'running' || current.status === 'seeding' || current.status === 'recomputing')) {
    current.stopFlag = true; return true;
  }
  return false;
}

export function startRun(partial: Partial<RunParams>): RunState {
  if (current && ['seeding', 'running', 'recomputing'].includes(current.status)) {
    throw new Error('A simulation run is already in progress. Stop it first.');
  }
  const params: RunParams = { ...DEFAULT_PARAMS, ...partial };
  const run: RunState = {
    run_id: randomUUID(), status: 'seeding', params, started_at: new Date().toISOString(),
    virtual_day: 0, progress: 0, error: null, last_snapshot: null, metrics: null,
    emitter: new EventEmitter(), stopFlag: false,
  };
  run.emitter.setMaxListeners(50);
  current = run;
  // Fire-and-forget; the loop drives status + emits snapshots.
  void execute(run).catch((e) => {
    run.status = 'error'; run.error = e?.message ?? String(e);
    run.emitter.emit('tick', { event: 'error', error: run.error });
  });
  return run;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function execute(run: RunState): Promise<void> {
  const p = run.params;
  const rng = new Rng(p.seed);

  // ── Seed population + graph ──────────────────────────────────────────────
  const now = new Date();
  const anchorStart = new Date(now.getTime() - p.virtual_days * 86400_000);
  const accounts: SimAccount[] = buildAccounts(rng, p.accounts, p.virtual_days);
  const graph: SimGraph = buildGraph(rng, accounts);
  const metrics = new SimMetrics(accounts);
  run.metrics = metrics;

  emit(run, { event: 'seeding', accounts: accounts.length });
  await seedDatabase(accounts, graph, anchorStart);
  const state: SimState = initState(rng, accounts, graph, p.virtual_days);

  run.status = 'running';
  emit(run, { event: 'seeded', accounts: accounts.length });

  // ── Virtual clock loop ────────────────────────────────────────────────────
  const totalSteps = Math.max(1, Math.round((p.virtual_days * 24) / p.step_hours));
  const intervalMs = (p.wall_minutes * 60_000) / totalSteps;
  let affected = new Set<string>();
  let lastRecomputeHours = 0;

  for (let step = 0; step < totalSteps; step++) {
    if (run.stopFlag) { run.status = 'stopped'; break; }
    const tStart = new Date(anchorStart.getTime() + step * p.step_hours * 3600_000);
    const tEnd = new Date(tStart.getTime() + p.step_hours * 3600_000);
    const elapsedHours = step * p.step_hours;
    const dayInt = Math.floor(elapsedHours / 24);
    const hourOfDay = elapsedHours % 24;

    const stepStart = Date.now();

    const res = generateWindow(rng, accounts, graph, state, dayInt, hourOfDay, p.step_hours, tStart, tEnd);
    await persistWindow(res, state);
    metrics.totalCalls += res.calls.length;
    metrics.totalBlocks += res.blocks.length;
    for (const u of res.affected) affected.add(u);

    run.virtual_day = dayInt;
    run.progress = (step + 1) / totalSteps;

    // Recompute on cadence.
    if (elapsedHours - lastRecomputeHours >= p.recompute_every_hours || step === totalSteps - 1) {
      lastRecomputeHours = elapsedHours;
      run.status = 'recomputing';
      const ids = [...affected];
      affected = new Set();
      const results = await recomputeAsOf(ids, tEnd, graph.byId);
      metrics.update(dayInt, results);
      metrics.recordTimeline(dayInt);
      run.status = 'running';
      const snap = metrics.snapshot(dayInt, dayInt, { progress: run.progress, status: run.status, recomputed: ids.length });
      run.last_snapshot = snap;
      emit(run, { event: 'tick', ...snap });
    }

    const spent = Date.now() - stepStart;
    if (spent < intervalMs) await sleep(intervalMs - spent);
  }

  // ── Final recompute over everyone as-of now ───────────────────────────────
  if (run.status !== 'stopped') {
    run.status = 'recomputing';
    const allIds = accounts.map(a => a.user_id);
    const results = await recomputeAsOf(allIds, now, graph.byId);
    metrics.update(p.virtual_days, results);
    metrics.recordTimeline(p.virtual_days);
    run.status = 'done';
    run.progress = 1;
  }

  const finalReport = metrics.final();
  run.last_snapshot = { event: 'done', status: run.status, ...metrics.snapshot(run.virtual_day, run.virtual_day) };
  emit(run, { event: 'done', status: run.status, summary: (finalReport as any).summary });

  // ── Teardown unless asked to keep ─────────────────────────────────────────
  if (!p.keep_data) {
    try { const t = await teardownSim(); emit(run, { event: 'teardown', ...t }); }
    catch (e: any) { emit(run, { event: 'teardown_error', error: e?.message ?? String(e) }); }
  }
}

function emit(run: RunState, payload: Record<string, unknown>): void {
  run.emitter.emit('tick', payload);
}

/** Build the final report (also available after completion). */
export function getReport(): Record<string, unknown> | null {
  if (!current?.metrics) return null;
  return current.metrics.final();
}
