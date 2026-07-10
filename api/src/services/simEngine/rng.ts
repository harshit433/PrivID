/**
 * Seeded PRNG for the time-series simulator (LCG — mirrors the big-run Rng,
 * with a float `range` helper). Deterministic: same seed → same run.
 */
export class Rng {
  private s: number;
  constructor(seed = 42) { this.s = seed >>> 0; }
  next(): number {
    this.s = ((Math.imul(1664525, this.s) + 1013904223) | 0) >>> 0;
    return this.s / 0xffffffff;
  }
  int(lo: number, hi: number): number { return Math.floor(this.next() * (hi - lo + 1)) + lo; }
  range(lo: number, hi: number): number { return lo + this.next() * (hi - lo); }
  bool(p: number): boolean { return this.next() < p; }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length)]; }
  /** Poisson sample (Knuth) — for per-window call counts. */
  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k++; p *= this.next(); } while (p > L);
    return k - 1;
  }
  shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}
