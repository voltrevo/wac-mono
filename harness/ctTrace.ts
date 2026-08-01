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
import type { CoveragePoint } from "wac/wacEmitFunc.ts";
import { wacFiles } from "./wacFiles.ts";

export type CtModule = {
  exports: Record<string, CallableFunction>;
  points: CoveragePoint[];
};

/** Compile an entry file with trace instrumentation and instantiate it. */
export async function ctModule(entry: string): Promise<CtModule> {
  const r = wacCompile(await wacFiles(entry), entry, { ctTrace: true });
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
  kind: CoveragePoint["kind"];
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
