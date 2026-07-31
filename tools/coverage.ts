// Branch coverage for the wac sources.
//
// Compiles with instrumentation, runs the same exercises the test suite runs,
// then reads the counters back out. Reports per-file percentages and lists the
// branch points that never executed — which is the actionable part, and the
// thing mutation testing can only approximate.
//
//   deno run -A tools/coverage.ts            # summary
//   deno run -A tools/coverage.ts --verbose  # plus every uncovered point

import { wacCompile } from "wac/wacCompile.ts";
import { wacBindgen } from "wac/wacBindgen.ts";
import { wacFiles } from "../harness/wacFiles.ts";
import { buildCorpus } from "../packages/gzip/test/fuzz/corpus.ts";

type Point = { index: number; file: string; line: number; col: number; kind: string };

const verbose = Deno.args.includes("--verbose");

/** Compile an entry point with instrumentation and import the bindgen'd module. */
async function instrument(entry: string): Promise<{
  mod: Record<string, unknown>;
  points: Point[];
}> {
  const result = wacCompile(await wacFiles(entry), entry, { coverage: true });
  if (!result.ok) {
    throw new Error(`compile failed:\n${result.diagnostics.map(d =>
      `  ${d.file}:${d.line}:${d.col} ${d.message}`).join("\n")}`);
  }
  const ts = wacBindgen(result.compiled);
  await Deno.mkdir(".cache", { recursive: true });
  const out = `.cache/cov_${entry.replaceAll("/", "_")}.gen.ts`;
  await Deno.writeTextFile(out, ts);
  return {
    mod: await import(`${Deno.cwd()}/${out}`),
    points: result.compiled.coverage!,
  };
}

// The compressor and the decompressor are separate entry points, so each gets its
// own instrumented module and its own counter array. Files reachable from both
// (buf, crc32, tables) appear in both reports; the union is what counts, so
// coverage is merged per (file, line, col) rather than per module.
const covered = new Set<string>();
const allPoints = new Map<string, Point>();

function record(points: Point[], counts: number[]): void {
  for (const p of points) {
    const key = `${p.file}:${p.line}:${p.col}:${p.kind}`;
    allPoints.set(key, p);
    if (counts[p.index] > 0) covered.add(key);
  }
}

function readCounts(mod: Record<string, unknown>, n: number): number[] {
  const get = mod.__cov_get as (i: number) => number;
  return Array.from({ length: n }, (_, i) => get(i));
}

// ── Exercise the compressor ───────────────────────────────────────────────────

{
  const { mod, points } = await instrument("packages/gzip/src/gzip.wac");
  (mod.__cov_init as () => void)();
  const len = (mod.__cov_len as () => number)();

  const stored = mod.gzipStored as (d: Uint8Array) => Uint8Array;
  const fixed = mod.gzipFixed as (d: Uint8Array) => Uint8Array;
  const dynamic = mod.gzipDynamic as (d: Uint8Array) => Uint8Array;
  const best = mod.gzipBest as (d: Uint8Array) => Uint8Array;

  // The fuzz corpus is the broadest set of shapes available, and reusing it means
  // this measures roughly what the suite measures.
  for (const { data } of buildCorpus(120, 20260731)) {
    stored(data); fixed(data); dynamic(data); best(data);
  }
  // Plus the boundary cases the corpus does not guarantee.
  for (const n of [0, 1, 2, 3, 258, 65535, 65536, 131071]) {
    const runs = new Uint8Array(n).fill(0x61);
    best(runs); dynamic(runs); stored(runs);
  }
  record(points, readCounts(mod, len));
}

// ── Exercise the decompressor ─────────────────────────────────────────────────

{
  const { mod, points } = await instrument("packages/gzip/src/inflate.wac");
  (mod.__cov_init as () => void)();
  const len = (mod.__cov_len as () => number)();

  const gunzipBytes = mod.gunzipBytes as (gz: Uint8Array) => Uint8Array;
  const inflateRaw = mod.inflate as (d: Uint8Array) => Uint8Array;

  // Streams from our own compressor, and from python at every level so stored,
  // fixed and dynamic blocks all appear.
  const gz = await instrument("packages/gzip/src/gzip.wac");
  (gz.mod.__cov_init as () => void)();
  const best = gz.mod.gzipBest as (d: Uint8Array) => Uint8Array;
  const storedFn = gz.mod.gzipStored as (d: Uint8Array) => Uint8Array;
  const fixedFn = gz.mod.gzipFixed as (d: Uint8Array) => Uint8Array;

  const corpus = buildCorpus(60, 20260731);
  for (const { data } of corpus) {
    for (const fn of [best, storedFn, fixedFn]) {
      try { gunzipBytes(fn(data)); } catch { /* counted either way */ }
    }
  }

  // Malformed input, so the validity checks and trap paths are reached too.
  const valid = best(new TextEncoder().encode("coverage of error paths ".repeat(20)));
  for (let i = 0; i < valid.length; i += 3) {
    const bad = valid.slice();
    bad[i] ^= 0xFF;
    try { gunzipBytes(bad); } catch { /* expected */ }
    try { gunzipBytes(valid.slice(0, i)); } catch { /* expected */ }
  }
  try { inflateRaw(new Uint8Array([0x01, 0x00, 0x00, 0xFF, 0xFF])); } catch { /* empty stored */ }

  record(points, readCounts(mod, len));
}

// ── Exercise crc32 directly ───────────────────────────────────────────────────
//
// crc32Bitwise is the reference the table version is tested against, so it is
// never called from the pipeline. Instrumenting crc32.wac on its own keeps the
// number honest rather than reporting a tested function as uncovered.

{
  const { mod, points } = await instrument("packages/gzip/src/crc32.wac");
  (mod.__cov_init as () => void)();
  const len = (mod.__cov_len as () => number)();
  const table = mod.crc32 as (d: Uint8Array) => number;
  const bitwise = mod.crc32Bitwise as (d: Uint8Array) => number;
  for (const n of [0, 1, 2, 255, 256, 4096]) {
    const data = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xFF);
    if (table(data) !== bitwise(data)) {
      throw new Error(`crc32 disagrees with crc32Bitwise at length ${n}`);
    }
  }
  record(points, readCounts(mod, len));
}

// ── Exercise every package's wac test suite ───────────────────────────────────
//
// The gzip exercises above are hand-written because they drive a fuzz corpus, which is more
// thorough than any test file. Every *other* package is covered by running its wac-native tests
// with instrumentation — the tests are the exercise, and they are already there.
//
// This is why issue 0024 survived: branch coverage never instrumented `match` arms, and nothing
// noticed, because the only package under this tool contained no `match`. The packages that use one
// — fmt, json, wacc — were outside it. A whole class of instrumentation bug is undetectable while
// the measured set and the feature-using set do not overlap, so the fix is to stop having a
// measured set [issue 0025].
//
// Discovery is by directory rather than a list, so a new package is covered by default and has to
// opt *out* by having no wac tests.

async function wacTestFiles(): Promise<string[]> {
  const out: string[] = [];
  for await (const pkg of Deno.readDir("packages")) {
    if (!pkg.isDirectory) continue;
    const dir = `packages/${pkg.name}/test/wac`;
    try {
      for await (const f of Deno.readDir(dir)) {
        // `probe.wac` and friends are scratch files for host-side tests, not test suites: a test
        // file is one that exports `test*` functions, which is checked after compiling.
        if (f.isFile && f.name.endsWith("_test.wac")) out.push(`${dir}/${f.name}`);
      }
    } catch { /* the package has no wac tests */ }
  }
  return out.sort();
}

for (const entry of await wacTestFiles()) {
  const { mod, points } = await instrument(entry);
  (mod.__cov_init as () => void)();
  const len = (mod.__cov_len as () => number)();

  // Every no-argument export named test* returning a string is a test, the same rule
  // `harness/wacTestRun.ts` uses. Running them is the exercise.
  let ran = 0;
  for (const [name, fn] of Object.entries(mod)) {
    if (!name.startsWith("test") || typeof fn !== "function") continue;
    try { (fn as () => unknown)(); ran++; } catch (e) {
      // A failing wac test is the test suite's business, not this tool's — but a *trap* would
      // leave the counters half-filled, so it is worth saying which file did it.
      console.warn(`  note: ${entry} ${name} threw during coverage: ${String(e).split("\n")[0]}`);
    }
  }
  if (ran === 0) console.warn(`  note: ${entry} exported no runnable tests`);
  record(points, readCounts(mod, len));
}

// ── Report ────────────────────────────────────────────────────────────────────

const byFile = new Map<string, { total: number; hit: number; missing: Point[] }>();
for (const [key, p] of allPoints) {
  const f = byFile.get(p.file) ?? { total: 0, hit: 0, missing: [] };
  f.total++;
  if (covered.has(key)) f.hit++;
  else f.missing.push(p);
  byFile.set(p.file, f);
}

const pct = (hit: number, total: number) => total === 0 ? 100 : (100 * hit / total);

console.log("branch coverage of the wac sources\n");
console.log("| file | points | covered | % |");
console.log("|---|---:|---:|---:|");
let total = 0, hit = 0;
for (const [file, f] of [...byFile].sort()) {
  total += f.total; hit += f.hit;
  console.log(`| ${file} | ${f.total} | ${f.hit} | ${pct(f.hit, f.total).toFixed(1)} |`);
}
console.log(`| **all** | **${total}** | **${hit}** | **${pct(hit, total).toFixed(1)}** |`);

const missing = [...byFile].flatMap(([, f]) => f.missing);
if (missing.length > 0) {
  console.log(`\n${missing.length} branch point(s) never executed:`);
  const show = verbose ? missing : missing.slice(0, 15);
  for (const p of show.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    console.log(`  ${p.file}:${p.line}:${p.col}  ${p.kind}`);
  }
  if (!verbose && missing.length > show.length) {
    console.log(`  ... and ${missing.length - show.length} more (--verbose for all)`);
  }
}
