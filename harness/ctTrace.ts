// ctTrace — check that a routine's observable behaviour does not depend on a secret.
//
// Compiles with the compiler's `ctTrace` mode, which records an ordered trace of two
// kinds of event: every branch taken, and every array index used. Then runs the same
// function twice with the same public input and different secrets, and compares.
//
// **Both kinds matter, and branch coverage only sees one.** A secret-dependent branch
// is the obvious leak. A secret-dependent *index* has no branch at all — `SBOX[key]`
// touches a cache line chosen by the key, which is how AES keys have been recovered
// from cache timing since 2005 — and a tool that counts branches reports it as
// perfectly uniform.
//
// ## What a pass means, and what it does not
//
// A pass says: for *these inputs*, on the path taken, the wasm-level sequence of
// branches and memory indices did not vary with the secret. That is a necessary
// condition for constant time, not a sufficient one.
//
//   - It is dynamic. Untested key pairs prove nothing; use many, including
//     structured ones (all zero, all ones, single bit set).
//   - It is wasm-level. Identical operations can still take different time:
//     `i64.div_s` latency depends on its operands on some hardware, and the engine
//     and CPU are free to do their own thing.
//   - It says nothing about the value written, only about branches and addresses.
//
// A *failure*, on the other hand, is definite: the trace really did diverge, at a
// named source line.

import { wacCompile } from "wac/wacCompile.ts";
import { wacFiles } from "./wacFiles.ts";

/**
 * The compiler's point record, described structurally rather than imported.
 *
 * Importing `CoveragePoint` would tie this file to the compiler's exact union of
 * point kinds, and `wac/` resolves to whatever sibling checkout the reader happens
 * to have. When trace mode added an `"index"` kind, every checkout without it failed
 * to *type-check* — which took down the whole suite, not just these tests, and scored
 * a mutation run as all-killed because the runner exited non-zero for the wrong
 * reason [wac-mono issue 0008]. A structural type and string comparisons work against
 * a compiler that has the feature and one that does not.
 */
export type TracePoint = { index: number; file: string; line: number; col: number; kind: string };

export type CtModule = {
  exports: Record<string, CallableFunction>;
  points: TracePoint[];
};

/**
 * Whether the compiler in this checkout has trace mode at all.
 *
 * Probed by compiling a program with one branch and one indexed read: with the mode,
 * the module exports the coverage accessors and the log records both. Without it, the
 * unknown option is ignored and there is nothing to read. Cached, because it compiles.
 */
let available: boolean | undefined;
export function ctTraceAvailable(): boolean {
  if (available !== undefined) return available;
  const src = `const u8[] T = u8[](1, 2);\nexport i32 f(i32 s) { return T[s & 1]; }\n`;
  try {
    const r = wacCompile(new Map([["p.wac", src]]), "p.wac", { ctTrace: true } as Record<string, unknown>);
    if (!r.ok) return (available = false);
    const kinds = new Set((r.compiled.coverage ?? []).map((p) => p.kind as string));
    available = kinds.has("index");
  } catch {
    available = false;
  }
  return available;
}

/** Compile an entry file with trace instrumentation and instantiate it. */
export async function ctModule(entry: string): Promise<CtModule> {
  // Cast, so this compiles against a compiler whose options type predates `ctTrace`.
  // A compiler that does not know the option ignores it, which `ctTraceAvailable`
  // detects rather than letting it look like a clean result.
  const r = wacCompile(await wacFiles(entry), entry, { ctTrace: true } as Record<string, unknown>);
  if (!r.ok) {
    throw new Error(`ctTrace: ${entry} did not compile:\n` +
      r.diagnostics.map((d) => `  ${d.file}:${d.line} ${d.message}`).join("\n"));
  }
  const { instance } = await WebAssembly.instantiate(r.compiled.wasm as BufferSource, {});
  return {
    exports: instance.exports as Record<string, CallableFunction>,
    points: r.compiled.coverage!,
  };
}

/** One recorded event: which instrumented site, and the index it used (0 for a branch). */
export type Event = { site: number; value: number };

/** Run `body` and return the trace it produced. */
export function traceOf(m: CtModule, body: () => void): { events: Event[]; truncated: boolean } {
  const ex = m.exports;
  ex.__cov_init();
  body();
  const used = ex.__cov_get(0) as number;
  const capacity = ex.__cov_len() as number;
  const events: Event[] = [];
  for (let k = 0; k * 2 < used; k++) {
    events.push({ site: ex.__cov_get(1 + 2 * k) as number, value: ex.__cov_get(2 + 2 * k) as number });
  }
  // The append stops silently when the log fills, so a trace that reaches the end
  // may be a prefix. Saying so beats comparing two truncations and calling it a pass.
  return { events, truncated: used + 3 >= capacity };
}

export type Divergence = {
  at: number;
  file: string;
  line: number;
  /**
   * `index` — this site used a different index, which is a leak *here*.
   * `path-split` — the runs took different paths, and this is merely where one of
   * them stood. Everything after it is incomparable, not clean.
   */
  kind: string;
  detail: string;
};

/**
 * The first point at which two traces differ, or null if they are identical.
 *
 * A length difference is a divergence too — one run took a branch the other did not,
 * and it is reported at the point where the shorter trace ran out.
 */
export function firstDivergence(
  m: CtModule,
  a: { events: Event[] },
  b: { events: Event[] },
): Divergence | null {
  const n = Math.min(a.events.length, b.events.length);
  for (let k = 0; k < n; k++) {
    const x = a.events[k], y = b.events[k];
    if (x.site === y.site && x.value === y.value) continue;
    const p = m.points[x.site];
    return {
      at: k, file: p.file, line: p.line, kind: p.kind,
      detail: x.site !== y.site
        ? `took a different path here (also reached ${m.points[y.site].file}:${m.points[y.site].line})`
        : `index ${x.value} vs ${y.value}`,
    };
  }
  if (a.events.length === b.events.length) return null;
  const longer = a.events.length > b.events.length ? a : b;
  const p = m.points[longer.events[n].site];
  return {
    at: n, file: p.file, line: p.line, kind: p.kind,
    detail: `one run performed ${Math.abs(a.events.length - b.events.length)} more ` +
      `operation(s); the other stopped here`,
  };
}

/**
 * Every site at which two traces diverge, up to the point where comparison stops
 * meaning anything.
 *
 * `firstDivergence` is what a test assertion wants — one place, one message. A survey
 * wants the list, because a routine that leaks in several places reports only the
 * earliest otherwise.
 *
 * **Two kinds of divergence, and only one is recoverable.** If both runs are at the
 * same site and used different indices, the paths still agree and the walk continues:
 * that is an index leak, and there may be more after it. If they are at *different*
 * sites the control flow has split, and from there the two event streams describe
 * different executions — pairing them up produces noise, not findings. So the walk
 * reports that divergence and stops.
 *
 * Resynchronising by guesswork was the first attempt and it invented leaks: after
 * ghash's loop count changed, misaligned events reported `y[0] = tmp[0]` — a constant
 * index — as key-dependent. An over-reporting security tool gets ignored, which is
 * worse than a quiet one.
 */
export function allDivergentSites(
  m: CtModule,
  a: { events: Event[] },
  b: { events: Event[] },
): { sites: Divergence[]; stoppedAtPathSplit: boolean } {
  const sites: Divergence[] = [];
  const seen = new Set<number>();
  const n = Math.min(a.events.length, b.events.length);
  for (let k = 0; k < n; k++) {
    const x = a.events[k], y = b.events[k];
    if (x.site === y.site && x.value === y.value) continue;
    const p = m.points[x.site];
    if (x.site !== y.site) {
      // Not a leaking site: it is where *this* run happened to be when the two stopped
      // agreeing. The other run was somewhere else, and naming both is the only honest
      // report — `ghash.wac:63` indexes with a literal 0 and cannot itself depend on a
      // key, but it is where one run stood at the split.
      const q = m.points[y.site];
      sites.push({
        at: k, file: p.file, line: p.line, kind: "path-split",
        detail: `one run at ${p.file}:${p.line}, the other at ${q.file}:${q.line}`,
      });
      return { sites, stoppedAtPathSplit: true };
    }
    if (!seen.has(x.site)) {
      seen.add(x.site);
      sites.push({ at: k, file: p.file, line: p.line, kind: p.kind, detail: `index ${x.value} vs ${y.value}` });
    }
  }
  if (a.events.length !== b.events.length) {
    const longer = a.events.length > b.events.length ? a : b;
    const p = m.points[longer.events[n].site];
    sites.push({
      at: n, file: p.file, line: p.line, kind: "path-split",
      detail: `one run continued past the other, which stopped at ${p.file}:${p.line}`,
    });
    return { sites, stoppedAtPathSplit: true };
  }
  return { sites, stoppedAtPathSplit: false };
}

/**
 * Assert that `run(secret)` traces identically for every secret given.
 *
 * Every secret is compared against the first, so a report names the pair that
 * disagreed rather than only that something did.
 */
export function assertNoSecretDependence<S>(
  m: CtModule,
  secrets: S[],
  run: (secret: S) => void,
  label = "routine",
): void {
  if (secrets.length < 2) throw new Error("need at least two secrets to compare");
  const base = traceOf(m, () => run(secrets[0]));
  if (base.truncated) throw new Error(`${label}: trace log overflowed; raise TRACE_SLOTS`);
  // An empty trace is not a pass, it is a routine that never ran — a mistyped export
  // name returns undefined and calls nothing, and comparing nothing to nothing agrees.
  if (base.events.length === 0) {
    throw new Error(`${label}: recorded no events at all — did the call actually happen?`);
  }
  for (let i = 1; i < secrets.length; i++) {
    const other = traceOf(m, () => run(secrets[i]));
    const d = firstDivergence(m, base, other);
    if (d) {
      throw new Error(
        `${label}: behaviour depends on the secret.\n` +
        `  secret #0 vs #${i}, event ${d.at}\n` +
        `  ${d.file}:${d.line} (${d.kind}) — ${d.detail}`,
      );
    }
  }
}
