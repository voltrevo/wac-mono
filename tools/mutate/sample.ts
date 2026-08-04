// Random sampling of a mutant set, for a run you will actually sit through.
//
// A whole-package sweep at `--operators=all` is minutes to tens of minutes, which in practice means
// it is run rarely and the number is usually stale. Mutant sampling is the standard answer: a random
// subset estimates the mutation score of the whole set, and it has been known since Acree and Budd
// that a fairly small fraction tracks the full figure closely. A five-minute sample you run beats a
// half-hour sweep you keep meaning to.
//
// Separate module and a pure function so it can be tested. The seeding and the stratification are
// both easy to get subtly wrong in ways that only show up as a quietly lopsided sample.

import type { Mutant } from "./types.ts";

/** mulberry32 — small, fast, and good enough to shuffle with. */
export function mulberry32(a: number): () => number {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `n` mutants drawn from `mutants`, stratified by file.
 *
 * **Stratified rather than uniform.** A uniform draw over `bls` would be dominated by whichever file
 * holds the most mutants — one file can hold a fifth of them — and could return nothing at all about
 * a small file, which is where the interesting gaps usually are. Round-robin across files guarantees
 * every file is represented before any file gets a second mutant.
 *
 * Deterministic in `seed`: the same seed gives the same draw, so a surprising result can be
 * reproduced exactly. The caller supplies a random seed by default and prints it, so that repeated
 * runs cover different ground instead of re-asking one subset for ever.
 *
 * Returns the input unchanged when `n` is not a useful number or is not smaller than the population.
 */
export function sampleMutants(mutants: Mutant[], n: number, seed: number): Mutant[] {
  if (!Number.isFinite(n) || n <= 0 || n >= mutants.length) return mutants;
  const rand = mulberry32(seed);

  const byFile = new Map<string, Mutant[]>();
  for (const m of mutants) {
    const key = m.edits[0]?.file ?? "";
    const list = byFile.get(key);
    if (list === undefined) byFile.set(key, [m]);
    else list.push(m);
  }

  // Sorted keys so the grouping does not depend on iteration order, then Fisher-Yates within each
  // file, then one per file per round.
  const groups = [...byFile.keys()].sort().map((k) => {
    const g = byFile.get(k)!.slice();
    for (let i = g.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [g[i], g[j]] = [g[j], g[i]];
    }
    return g;
  });

  const picked: Mutant[] = [];
  for (let round = 0; picked.length < n; round++) {
    let tookAny = false;
    for (const g of groups) {
      if (round >= g.length) continue;
      picked.push(g[round]);
      tookAny = true;
      if (picked.length === n) break;
    }
    if (!tookAny) break;      // every file exhausted; `n` exceeded what the strata hold
  }
  return picked;
}

/** How many files the draw spans, for the line the run prints. */
export function fileCount(mutants: Mutant[]): number {
  return new Set(mutants.map((m) => m.edits[0]?.file ?? "")).size;
}
