// Mutation testing for the wac sources.
//
// Coverage says a line ran. Mutation testing says something stronger and much harder to
// fake: break the line on purpose, and see whether anything notices. A surviving mutant
// names a behaviour nothing checks — which is the failure coverage structurally cannot
// see, because a test can execute a line thoroughly and assert nothing about it.
//
//   deno task mutate                     # curated mutations only, as before
//   deno task mutate --operators         # ...plus guard and extreme mutants
//   deno task mutate --operators=all     # ...plus relational and literal too (slow)
//   deno task mutate --diff              # only files changed against origin/master
//   deno task mutate crc                 # only mutants whose name matches
//   deno task mutate --package gzip      # only mutants in one package
//   deno task mutate --jobs=2            # how many to test at once (default: cores - 1, max 4)
//   deno task mutate --no-select         # skip per-test selection, run every test in scope
//   deno task mutate --no-sample         # mutate every integer literal, not one per repeated shape
//   deno task mutate --no-nice           # do not yield to other work (only on a machine you own)
//   deno task mutate --sample=150        # run a random 150 of the selected mutants (see --seed)
//   deno task mutate --seed=12345        # reproduce a particular --sample draw
//   deno task mutate --operators --dry-run   # what would run, without running it
//
// Four things make this affordable enough to run over more than one package.
//
// **Trivial Compiler Equivalence.** Every mutant is compiled before any test runs. If
// its wasm is byte-identical to the original's, the mutation provably changed nothing
// and no test could ever kill it — it is discarded, not counted. If its wasm matches
// another mutant's, the two are the same experiment and only one is run. This is
// Papadakis et al.'s TCE, and it is unusually cheap here because the compiler is an
// in-process function returning bytes: no subprocess, no temp directory, milliseconds.
//
// **Scoped test runs.** A mutant is tested against the packages that actually depend on
// the file it edits, computed from the real import graph rather than guessed from the
// path. Mutating `bytes` still runs gzip's and json's tests, because they import it;
// mutating `crypto` runs only crypto's.
//
// **Stage once.** The project is copied to a scratch directory a single time, then each
// mutant patches and restores the files it touches, rather than re-copying the tree.
//
// **One literal mutant per repeated statement shape.** `--operators=all` bumps every integer
// literal by one, and this repo is full of code where that is the same experiment over and over: a
// constant table is one question ("would anything notice a corrupted entry?") asked once per entry,
// and unrolled arithmetic is one question asked once per limb. Measured across `packages/`:
//
//     packages/unicode/src/tables.wac    8787 literal mutants -> 47
//     packages/bls/src/fpkernel.wac      1221 -> 156
//     packages/crypto/src/blowfish.wac   1128 -> 130
//     packages/crypto/src/aes.wac         643 -> 119
//     packages/sh/src/exec.wac            429 -> 416     <- logic, correctly almost untouched
//     repo total                        28226 -> 13376
//
// A whole-package sweep of `unicode` went from about nine thousand mutants to 251. See `shapeKey`
// in `mutate/operators.ts` for what counts as the same shape and why it is scoped per function and
// per module-level `const`. The run prints what it sampled — a sweep that declines to ask a question
// must not look like one that asked and got an answer.
//
// **This can hide a survivor**, and that is the trade: a table entry that only the five-hundredth
// element would have exposed is no longer tested, where the previous behaviour was merely slow. It
// is why the sample is three spread through each class rather than one, and why the header says so.
// `--no-sample` restores the old behaviour for a deliberate deep run.
//
// Outcomes are three, not two. A mutant that fails to compile is INVALID, not killed:
// it tested nothing about the test suite, and counting it as a kill inflates the score.
// That distinction barely mattered for a hand-written list where every mutation was
// known to build; it is the difference between a meaningful number and a meaningless
// one as soon as mutants are generated mechanically.

import { wacCompile } from "wac/wacCompile.ts";
import { wacFiles, wacFilesIn } from "../harness/wacFiles.ts";
import { CURATED } from "./mutate/curated.ts";
import { KNOWN_SURVIVORS } from "./mutate/known.ts";
import { fileCount, sampleMutants } from "./mutate/sample.ts";
import {
  buildProfile, byCost, filterFor, selectTests, testFilesIn, type Profile,
} from "./mutate/profile.ts";
import { ALL_OPERATORS, generate, type OperatorName } from "./mutate/operators.ts";
import { applyEdits, packagesOf, type Curated, type Edit, type Mutant } from "./mutate/types.ts";
import { SUITE_ENV } from "./suiteGuard.ts";


const args = Deno.args;
/**
 * `--operators` with an optional comma list; bare means the default set.
 *
 * The default is deliberately not everything. Generating every operator over the repo
 * produces 6,281 mutants — roughly eight hours even with scoped runs — and most of that
 * is `literal` (3,856) and `relational` (2,029), which are high-volume and low average
 * signal: many are killed by the first test that touches the line, and many more are
 * duplicates of each other. `guard` (46) and `extreme` (350) are the opposite: a removed
 * validity check and a gutted function are each worth reading when they survive. Ask for
 * the rest explicitly, ideally with --diff or --package.
 */
const opArg = args.find((a) => a.startsWith("--operators"));
const DEFAULT_OPERATORS: OperatorName[] = ["guard", "extreme"];
const operators: OperatorName[] = opArg === undefined
  ? []
  : !opArg.includes("=")
  ? DEFAULT_OPERATORS
  : opArg.split("=")[1] === "all"
  ? ALL_OPERATORS
  : opArg.split("=")[1].split(",").map((o) => o.trim()) as OperatorName[];
const useOperators = operators.length > 0;
const diffOnly = args.includes("--diff");
/** Generate and triage, but run nothing — for seeing what a run would cost. */
const dryRun = args.includes("--dry-run");
const pkgArg = args.includes("--package") ? args[args.indexOf("--package") + 1] : undefined;
const filter = args.find((a) => !a.startsWith("--") && a !== pkgArg);
/**
 * A mutant that hangs the suite is a real outcome, not a reason to wait forever — but the deadline
 * has to be relative to how fast this machine is *right now*, not a fixed wall-clock.
 *
 * This is the whole reason a sweep may be `nice`d. A timeout is scored as a **kill**, on the sound
 * argument that an infinite loop is a detected defect. The unsound consequence, if the deadline is
 * absolute, is that anything slowing the sweep down converts survivors into kills: the sweep reports
 * a *better* score for running on a loaded machine, or for being polite to other processes. That is
 * the worst direction for a measurement error, and it is why wac-mono issue 0031 was filed rather
 * than fixed — you cannot make a sweep yield until its clock stops depending on getting the machine
 * to itself.
 *
 * So the deadline is `max(FLOOR, observed baseline for this scope x MULTIPLIER)`. `mutate.ts` already
 * runs every scope unmutated before mutating anything, in the same conditions and the same staged
 * tree; timing that run is free and it is the only honest yardstick available. Under load the
 * baseline is slow too, so the deadline stretches with it and no verdict changes.
 *
 * The multiplier is generous on purpose. A mutant is either detected — usually in the first failing
 * test, with `--fail-fast` — or it runs to completion in about baseline time. Ten times baseline is
 * not "a bit slow", it is hung.
 */
const TIMEOUT_MULTIPLIER = 10;
const TIMEOUT_FLOOR_MS = 30_000;
const TIMEOUT_CAP_MS = 600_000;

/**
 * `nice`, so a sweep yields to whatever somebody is waiting on.
 *
 * A mutation sweep is background work by definition: nobody is watching an individual mutant. An
 * ordinary `deno task test` next door is the opposite. On five shared cores, a sweep at four
 * concurrent scopes — each a whole `deno test`, and `box.test.ts` alone spawns about three hundred
 * built binaries — took another agent's fifty-second suite to over half an hour, at load average
 * 10.55. They killed it at thirty minutes believing it had deadlocked and spent an hour proving it
 * had not. See wac-mono issue 0031.
 *
 * `--no-nice` exists for a sweep on a machine you have to yourself, where it is pure overhead.
 */
const NICE = !args.includes("--no-nice");

/** The deadline for a mutant whose scope took `baseline` ms unmutated. */
function deadlineFor(baseline: number): number {
  return Math.min(TIMEOUT_CAP_MS, Math.max(TIMEOUT_FLOOR_MS, baseline * TIMEOUT_MULTIPLIER));
}

// ── The source universe ───────────────────────────────────────────────────────

/** Every `.wac` file under `packages/`, by path. */
async function allWacFiles(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for await (const e of Deno.readDir(dir)) {
      const path = `${dir}/${e.name}`;
      if (e.isDirectory) await walk(path);
      else if (e.isFile && e.name.endsWith(".wac")) out.push(path);
    }
  };
  await walk("packages");
  return out.sort();
}

const wacPaths = await allWacFiles();
const sources = new Map<string, string>();
for (const p of wacPaths) sources.set(p, await Deno.readTextFile(p));

/**
 * Which packages' tests can observe a change to each file, from the import graph.
 *
 * Scoping by the mutated file's own package would be wrong rather than merely coarse:
 * `bytes` is imported by gzip, json and crypto, so a mutation there is killed by tests
 * that live somewhere else entirely. Reading the graph is the difference between a
 * faster run and a run that invents survivors.
 */
async function dependents(): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  const entries = wacPaths.filter((p) => /\/(src|test\/wac|bench)\//.test(p));
  for (const entry of entries) {
    const pkg = entry.split("/")[1];
    let included: Map<string, string>;
    try {
      included = await wacFiles(entry);
    } catch {
      continue;   // an entry that does not resolve is the suite's problem, not ours
    }
    for (const file of included.keys()) {
      const set = map.get(file) ?? new Set<string>();
      set.add(pkg);
      map.set(file, set);
    }
  }
  return map;
}

const DEPENDENTS = await dependents();

// ── Locating the curated mutations ────────────────────────────────────────────

type Located = { mutant: Mutant } | { name: string; problem: string };

function locate(c: Curated): Located {
  const raw = c.edits ?? [{ file: c.file!, find: c.find!, replace: c.replace!, nth: c.nth }];
  const edits: Edit[] = [];
  for (const r of raw) {
    const text = sources.get(r.file);
    if (text === undefined) return { name: c.name, problem: `no such file: ${r.file}` };
    const hits: number[] = [];
    for (let i = text.indexOf(r.find); i !== -1; i = text.indexOf(r.find, i + 1)) hits.push(i);
    if (hits.length === 0) {
      return { name: c.name, problem: `pattern not found in ${r.file}: ${JSON.stringify(r.find)}` };
    }
    const nth = r.nth ?? c.nth;
    if (hits.length > 1 && nth === undefined) {
      return {
        name: c.name,
        problem: `pattern occurs ${hits.length} times in ${r.file} and no \`nth\` says which — ` +
          `${JSON.stringify(r.find)}`,
      };
    }
    const at = hits[(nth ?? 1) - 1];
    if (at === undefined) {
      return { name: c.name, problem: `nth: ${nth} but only ${hits.length} occurrence(s) in ${r.file}` };
    }
    edits.push({ file: r.file, start: at, end: at + r.find.length, replacement: r.replace, was: r.find });
  }
  return {
    mutant: {
      name: c.name,
      edits,
      origin: "curated",
      ratioOnly: c.ratioOnly,
      mustSurvive: c.mustSurvive,
      equivalent: c.equivalent,
    },
  };
}

// ── Build the mutant set ──────────────────────────────────────────────────────

async function changedFiles(): Promise<Set<string>> {
  const cmd = new Deno.Command("git", {
    args: ["diff", "--name-only", "origin/master...HEAD"],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout } = await cmd.output();
  if (code !== 0) return new Set();
  return new Set(new TextDecoder().decode(stdout).split("\n").filter((l) => l.endsWith(".wac")));
}

const located = CURATED.map(locate);
const broken = located.filter((l): l is { name: string; problem: string } => "problem" in l);
let mutants = located.filter((l): l is { mutant: Mutant } => "mutant" in l).map((l) => l.mutant);

const genStats = { literalSampled: 0, literalSkipped: 0, shapes: 0 };
// `--no-sample`: mutate every integer literal, as this did before shape sampling existed. Slow by
// design — it is the flag for "I want the survivor that sampling might have hidden".
const perShape = args.includes("--no-sample") ? Number.POSITIVE_INFINITY : 3;
if (useOperators) {
  for (const [file, text] of sources) {
    // Test fixtures and benchmarks are not the code under test.
    if (/\/(test|bench)\//.test(file)) continue;
    mutants.push(...generate(file, text, operators, genStats, perShape));
  }
}

if (diffOnly) {
  const changed = await changedFiles();
  mutants = mutants.filter((m) => m.edits.some((e) => changed.has(e.file)));
  console.log(`--diff: ${changed.size} changed .wac file(s)`);
}
if (pkgArg !== undefined) mutants = mutants.filter((m) => packagesOf(m).includes(pkgArg));
if (filter !== undefined) mutants = mutants.filter((m) => m.name.includes(filter));

// `--sample=N`: run a random N of the selected mutants, stratified by file. See `mutate/sample.ts`
// for why stratified and why seeded; the seed is printed so a surprising draw can be reproduced.
const sampleFlag = args.find((a) => a.startsWith("--sample="));
const seedFlag = args.find((a) => a.startsWith("--seed="));
const seed = seedFlag !== undefined ? Number(seedFlag.split("=")[1]) : (Date.now() & 0x7fffffff);
if (sampleFlag !== undefined) {
  const n = Number(sampleFlag.split("=")[1]);
  const before = mutants.length;
  mutants = sampleMutants(mutants, n, seed);
  if (mutants.length < before) {
    console.log(
      `sample: ${mutants.length} of ${before} mutant(s), stratified across ` +
        `${fileCount(mutants)} file(s) — the score below estimates the whole set rather than ` +
        `being it. Reproduce this draw with --seed=${seed}`,
    );
  }
}

// Say what the literal operator sampled rather than leaving it to be inferred from a small number.
// 0024's `0/117 fell back` is the precedent: a count nobody explains gets read as good news, and a
// sweep that quietly declines to ask a question must not look like one that asked and got an answer.
if (genStats.literalSkipped > 0) {
  const total = genStats.literalSampled + genStats.literalSkipped;
  console.log(
    `literal: ${genStats.literalSampled} of ${total} integer literals mutated — ` +
      `at most ${perShape} per repeated statement shape, across ${genStats.shapes} shapes. ` +
      `Constant tables and unrolled code repeat one experiment; see tools/mutate/operators.ts.`,
  );
}

if (broken.length > 0) {
  console.log(`${broken.length} curated mutation(s) could not be located:`);
  for (const b of broken) console.log(`  - ${b.name}: ${b.problem}`);
  console.log();
}
if (mutants.length === 0) {
  console.error("no mutants selected");
  Deno.exit(broken.length > 0 ? 1 : 2);
}

// ── Trivial Compiler Equivalence ──────────────────────────────────────────────

/**
 * Compile one file as its own entry and hash the wasm.
 *
 * Every .wac file is a module and compiles standalone, which makes the file the natural
 * unit here: a mutation changes one file, so that file's own compilation is the smallest
 * thing whose bytes can answer "did this change anything at all".
 */
function wasmHash(files: Map<string, string>, entry: string): string | null {
  // Narrowed to the entry's own import graph. Handing `wacCompile` every file in the repo means
  // a single unrelated file that does not parse makes *every* mutant in *every* package report
  // "did not compile" — which is exactly what `packages/tor/size/tor_only.wac` did, silently, and
  // for a one-line syntax error nothing else in the suite reaches.
  const result = wacCompile(wacFilesIn(files, entry), entry);
  if (!result.ok) return null;
  const bytes = result.compiled.wasm;
  // Two 32-bit FNV-1a lanes with different offset bases, combined with the length.
  // This only has to distinguish, not resist anything — but it does run over every byte
  // of every mutant's wasm, so it has to be cheap. The first version used a 64-bit
  // BigInt lane and spent most of the triage phase in bignum arithmetic.
  let a = 0x811C9DC5, b = 0x01000193;
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i], 0x01000193);
    b = Math.imul(b ^ bytes[i], 0x85EBCA6B);
  }
  return `${bytes.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
}

const baseline = new Map<string, string | null>();
for (const m of mutants) {
  for (const e of m.edits) {
    if (!baseline.has(e.file)) baseline.set(e.file, wasmHash(sources, e.file));
  }
}

// A file that does not compile *before* being mutated is not a mutation result, and reporting it
// as one is how mutation testing dies quietly: every mutant in the file comes back INVALID, which
// reads as "the mutations were bad" rather than "the baseline is broken". Say so and stop.
const brokenBaseline = [...baseline.entries()].filter(([, h]) => h === null).map(([f]) => f);
if (brokenBaseline.length > 0) {
  console.error(
    `these file(s) do not compile before any mutation, so nothing here can be measured:\n` +
    brokenBaseline.map((f) => `  - ${f}`).join("\n") +
    `\n\nFix them, or narrow the run with --package / --diff.`,
  );
  Deno.exit(1);
}

type Triage =
  | { verdict: "run" }
  | { verdict: "equivalent" }
  | { verdict: "duplicate"; of: string }
  | { verdict: "invalid"; detail: string };

const seenHash = new Map<string, string>();   // wasm hash -> first mutant with it
/** Whether each control mutant compiled to byte-identical wasm, which it must. */
const controlIsNoop = new Map<string, boolean>();

function triage(m: Mutant): Triage {
  const mutated = applyEdits(sources, m);
  const parts: string[] = [];
  for (const file of [...new Set(m.edits.map((e) => e.file))].sort()) {
    const h = wasmHash(mutated, file);
    if (h === null) return { verdict: "invalid", detail: `${file} does not compile` };
    parts.push(`${file}=${h}`);
  }
  const signature = parts.join("|");
  const original = [...new Set(m.edits.map((e) => e.file))].sort()
    .map((f) => `${f}=${baseline.get(f)}`).join("|");
  const isNoop = signature === original;

  // A control mutant is a no-op by construction, so TCE proves it equivalent — and
  // discarding it on that basis would delete the only check that the staging and test
  // pipeline works at all. The two facts are both worth having, so the control is
  // always run, and whether TCE called it a no-op is recorded separately: a control
  // whose wasm *differs* is not a control any more, and TCE failing to notice a
  // genuine no-op would mean the equivalence detector is broken.
  if (m.mustSurvive === true) {
    controlIsNoop.set(m.name, isNoop);
    return { verdict: "run" };
  }

  if (isNoop) return { verdict: "equivalent" };
  const first = seenHash.get(signature);
  if (first !== undefined) return { verdict: "duplicate", of: first };
  seenHash.set(signature, m.name);
  return { verdict: "run" };
}

console.log(`${mutants.length} mutant(s) generated; compiling for equivalence…`);
const triaged = mutants.map((m) => ({ mutant: m, triage: triage(m) }));
const toRun = triaged.filter((t) => t.triage.verdict === "run");
const equivalent = triaged.filter((t) => t.triage.verdict === "equivalent");
const duplicate = triaged.filter((t) => t.triage.verdict === "duplicate");
const invalid = triaged.filter((t) => t.triage.verdict === "invalid");
console.log(
  `  ${toRun.length} to run, ${equivalent.length} provably equivalent, ` +
  `${duplicate.length} duplicate, ${invalid.length} did not compile\n`);

if (dryRun) {
  const byPkg = new Map<string, number>();
  for (const t of toRun) {
    for (const p of packagesOf(t.mutant)) byPkg.set(p, (byPkg.get(p) ?? 0) + 1);
  }
  console.log("mutants that would run, by package:");
  for (const [p, n] of [...byPkg].sort()) console.log(`  ${p.padEnd(10)} ${n}`);
  Deno.exit(0);
}

// ── Staging ───────────────────────────────────────────────────────────────────

/**
 * Copy the project to a scratch directory, once.
 *
 * deno.json's import map points at the wac compiler relatively ("../wac/"), which does
 * not resolve from a temp directory — so it is rewritten absolute. Without this the
 * staged project fails to type-check and *every* mutant reports as killed, which is why
 * there is a control mutation.
 */
async function stageProject(dest: string): Promise<void> {
  // `packages` and `harness` are the code. Every *file* at the repo root comes too, and that is not
  // tidiness: `packages/box/test/box.test.ts` reads `README.md` as its input — a real file of real
  // text to run `wc`, `sort` and `head` over — and staging without it made five box tests fail.
  //
  // The consequence was invisible and expensive. A red scope means every mutant in it is reported
  // as *unmeasurable* rather than killed, correctly and by design; but `box` depends on a dozen
  // packages, so one missing file silently withdrew a large part of the repo from measurement. A
  // `--package unicode --operators=all` run excluded 150 of 251 mutants for this reason, and said
  // so in a line easy to read as bookkeeping.
  //
  // Root files are a handful of kilobytes, so copying all of them is cheaper than maintaining a
  // list of which ones some test happens to read.
  for (const entry of ["packages", "harness"]) {
    const cmd = new Deno.Command("cp", { args: ["-r", entry, `${dest}/`] });
    const { code, stderr } = await cmd.output();
    if (code !== 0) throw new Error(`copy ${entry} failed: ${new TextDecoder().decode(stderr)}`);
  }
  for await (const e of Deno.readDir(".")) {
    if (!e.isFile) continue;
    await Deno.copyFile(e.name, `${dest}/${e.name}`);
  }
  const configPath = `${dest}/deno.json`;
  const config = JSON.parse(await Deno.readTextFile(configPath));
  const imports = config.imports ?? {};
  for (const [alias, target] of Object.entries(imports)) {
    if (typeof target === "string" && target.startsWith("../")) {
      imports[alias] = await Deno.realPath(target) + "/";
    }
  }
  config.imports = imports;
  await Deno.writeTextFile(configPath, JSON.stringify(config, null, 2));
}

/** Packages whose tests can see this mutant, from the import graph. */
function testDirs(m: Mutant): string[] {
  const pkgs = new Set<string>();
  for (const e of m.edits) {
    for (const p of DEPENDENTS.get(e.file) ?? []) pkgs.add(p);
    // A file nothing imports is still tested by its own package.
    for (const p of packagesOf(m)) pkgs.add(p);
  }
  return [...pkgs].sort().map((p) => `packages/${p}`);
}

/**
 * Run the suite in a staged directory. The one place that knows the command, so the
 * unmutated baseline cannot drift away from what the mutants are measured with.
 *
 * --no-check: a mutant is killed by behaviour, not by type errors. Skipping the check is
 * a quarter of the runtime, and it stops an unrelated type error somewhere in the suite
 * from failing every run and scoring every mutant as killed.
 *
 * --fail-fast: killing needs one failing test, and almost every mutant is killed, so
 * running the rest of the suite afterwards is pure waiting.
 *
 * --allow-net and --allow-env because the suite needs them: a permission error does not
 * skip a test, it fails the run.
 */
function testCommand(work: string, dirs: string[], filter?: string): Deno.Command {
  const denoArgs = ["test", "--no-check", "--fail-fast", "--allow-read", "--allow-write",
                    "--allow-run", "--allow-net", "--allow-env", "--quiet",
                    ...(filter ? ["--filter", filter] : []), ...dirs];
  // `nice` wraps the whole `deno test`, and the niceness is inherited by every subprocess it
  // spawns — which is the point, since those subprocesses are most of the load.
  // `SUITE_ENV` so a suite launched from inside one of these runs refuses rather than recursing, which
  // is what filled a machine to load 122 — wac-mono 0077.
  return NICE
    ? new Deno.Command("nice", {
      args: ["-n", "19", "deno", ...denoArgs],
      cwd: work,
      env: { ...SUITE_ENV },
      stdout: "piped",
      stderr: "piped",
    })
    : new Deno.Command("deno", {
      args: denoArgs,
      cwd: work,
      env: { ...SUITE_ENV },
      stdout: "piped",
      stderr: "piped",
    });
}

const runTests = (work: string, dirs: string[]) => testCommand(work, dirs).output();

/**
 * Every source line an edit touches, as "file:line".
 *
 * Edits are byte spans, and a curated one can cover several lines — the two-file
 * distance-guard mutation spans a whole `if`. A mutation is reachable if *any* of its
 * lines is, so all of them are looked up and the union of their tests is selected.
 */
function linesOf(file: string, start: number, end: number): string[] {
  const src = sources.get(file);
  if (src === undefined) return [];
  let line = 1;
  for (let i = 0; i < start && i < src.length; i++) if (src[i] === "\n") line++;
  const out = [`${file}:${line}`];
  for (let i = start; i < end && i < src.length; i++) {
    if (src[i] === "\n") { line++; out.push(`${file}:${line}`); }
  }
  return out;
}

type Result = {
  mutant: Mutant;
  killed: boolean;
  timedOut: boolean;
  dirs: string[];
  detail: string;
  /** The profile knows this line and no test reaches it, so nothing was run. */
  notCovered?: boolean;
};

/**
 * How many mutants to test at once.
 *
 * Each `deno test` uses a little over one core, so the useful number is a bit below the
 * core count rather than equal to it — oversubscribing makes every run slower and pushes
 * the slow ones towards TEST_TIMEOUT_MS, which would score them as killed for the wrong
 * reason. One core is left for this process and the OS.
 */
const jobs = (() => {
  const flag = args.find((a) => a.startsWith("--jobs"));
  const n = flag?.includes("=") ? Number(flag.split("=")[1]) : undefined;
  if (n && n > 0) return Math.floor(n);
  return Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
})();

/**
 * One staging directory per worker.
 *
 * The single shared directory is what forced this loop to be sequential: a mutant is
 * applied by writing the file, and two mutants in one tree would test each other's edits.
 * Staging is a `cp -r` of the project, so a handful of copies costs a second and some
 * disk, and buys the whole run being parallel.
 */
const workDirs: string[] = [];
let unmeasurable: typeof toRun = [];
let profile: Profile | null = null;
let narrowed = 0, widened = 0;
const noSelect = args.includes("--no-select");
let measurable: typeof toRun = [];
const results: (Result & { index: number })[] = [];
try {
  for (let i = 0; i < jobs; i++) {
    const dir = await Deno.makeTempDir({ prefix: "wac-mutate-" });
    workDirs.push(dir);
    await stageProject(dir);
  }
  if (jobs > 1) console.log(`  running ${jobs} at a time`);
  // Print the load, because this is the number that explains a slow sweep *and* a slow suite next
  // door, and because the alternative is somebody spending an hour proving the suite has not hung.
  // A job is a whole `deno test`, and several test files are themselves swarms of subprocesses, so
  // `jobs` understates the load by a lot — `box.test.ts` alone spawns about three hundred binaries.
  try {
    const load = (await Deno.readTextFile("/proc/loadavg")).split(" ").slice(0, 3).join(" ");
    const cores = navigator.hardwareConcurrency || 0;
    console.log(`  load before starting: ${load} on ${cores} core(s)`);
    if (Number(load.split(" ")[0]) > cores * 0.7) {
      console.log(
        "  NOTE: this machine is already busy. A sweep is background work — it is niced, so it " +
          "should yield,\n        but somebody may still be waiting on a suite. See issue 0031.",
      );
    }
  } catch { /* not Linux; the sweep does not depend on knowing */ }

  // ── The unmutated baseline ───────────────────────────────────────────────
  //
  // Run the suite once, unmutated, before mutating anything. Without this the harness
  // cannot tell "the mutation was detected" from "the tests were never going to pass":
  // a failing run is a non-zero exit either way, so a package whose suite is already red
  // — a missing permission, a type error, somebody else's broken test — scores *every*
  // mutant as killed and reports a perfect result. That is the failure mode worth
  // guarding, because its symptom is a better number rather than a worse one, and it
  // went unnoticed here long enough to produce two write-ups that were wrong.
  //
  // Per test-directory scope rather than once over everything, and the mutants in a red
  // scope are excluded rather than the run being abandoned. A mutant reaching into a
  // package somebody else has broken is unmeasurable, but the ones that do not are still
  // worth measuring — and refusing to run at all would mean any red package anywhere
  // blocks every sweep, which is how a guard gets switched off.
  const redScopes = new Set<string>();
  // How long each scope takes unmutated, in these conditions. The mutant deadline is a multiple of
  // this rather than a fixed wall-clock, so a slow machine stretches the deadline instead of
  // converting survivors into false kills. See TIMEOUT_MULTIPLIER.
  const baselineMs = new Map<string, number>();
  {
    const scopes = new Set(toRun.map((t) => testDirs(t.mutant).join(" ")));
    for (const key of [...scopes].sort()) {
      const dirs = key.split(" ").filter(Boolean);
      if (dirs.length === 0) continue;
      const started = performance.now();
      const { code, stdout, stderr } = await runTests(workDirs[0], dirs);
      baselineMs.set(key, performance.now() - started);
      if (code !== 0) {
        redScopes.add(key);
        const out = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
        const why = out.split("\n").find((l) => l.includes("FAILED") || l.includes("error")) ?? "";
        console.log(`  BASELINE RED: ${dirs.join(" ")} — ${why.trim().slice(0, 100)}`);
      }
    }
    const clean = scopes.size - redScopes.size;
    console.log(`  baseline: ${clean}/${scopes.size} test scope(s) pass unmutated`);
    const slowest = Math.max(0, ...baselineMs.values());
    console.log(
      `  deadline: ${TIMEOUT_MULTIPLIER}x each scope's own baseline ` +
        `(slowest ${(slowest / 1000).toFixed(1)}s -> ${(deadlineFor(slowest) / 1000).toFixed(0)}s), ` +
        `so load stretches it rather than manufacturing kills` +
        (NICE ? "; running under nice -n 19" : "; NOT niced (--no-nice)"),
    );
    if (clean === 0) {
      console.log("\nNothing is measurable: every scope this run touches is already failing.");
      console.log("Each mutant would be recorded as killed and the run would report a perfect");
      console.log("score. Fix the suite before trusting any number from here.");
      Deno.exit(2);
    }
  }
  unmeasurable = toRun.filter((t) => redScopes.has(testDirs(t.mutant).join(" ")));
  measurable = toRun.filter((t) => !redScopes.has(testDirs(t.mutant).join(" ")));

  // ── Per-test coverage, so a mutant only faces the tests that reach it ──────
  if (!noSelect && measurable.length > 0) {
    const scope = [...new Set(measurable.flatMap((t) => testDirs(t.mutant)))].sort();
    const files = await testFilesIn(scope.map((d) => `${workDirs[0]}/${d}`));
    const rel = files.map((f) => f.slice(workDirs[0].length + 1));
    profile = await buildProfile(workDirs[0], rel, (m) => console.log(m));
    console.log(
      `  profile: ${profile.home.size} test(s) across ${rel.length} file(s), ` +
      `${profile.known.size} covered line(s)`);
  }

  // ── Cheapest first, so `--fail-fast` stops early ──────────────────────────
  //
  // One entry per distinct scope, built once rather than per mutant. Passing the files instead of
  // the directory is the whole change: `deno test <dir>` discovers them itself, alphabetically,
  // and alphabetical is not correlated with cost. In `packages/ssh` it is close to the worst
  // order available — `cli` and `server` each spawn a real OpenSSH client, `transport` is
  // in-process, and `transport` sorts last.
  //
  // Ordering can only change how long a verdict takes, never what it is. Every file still runs
  // when nothing fails, and a mutant killed by the last file is killed either way.
  const scopeFiles = new Map<string, string[]>();
  {
    const scopes = new Set(measurable.map((t) => testDirs(t.mutant).join(" ")));
    for (const key of scopes) {
      const dirs = key.split(" ").filter(Boolean);
      if (dirs.length === 0) continue;
      const abs = await testFilesIn(dirs.map((d) => `${workDirs[0]}/${d}`));
      const rel = abs.map((f) => f.slice(workDirs[0].length + 1));
      if (rel.length > 0) scopeFiles.set(key, byCost(rel, profile ?? undefined));
    }
    if (profile) {
      const shown = [...scopeFiles.values()][0] ?? [];
      if (shown.length > 1) {
        const ms = (f: string) => Math.round(profile!.cost.get(f) ?? 0);
        console.log(`  order: ${shown.map((f) => `${f.split("/").pop()} ${ms(f)}ms`).join(" -> ")}`);
      }
    }
  }

  let next = 0;
  const worker = async (work: string) => {
    while (true) {
      const index = next++;
      if (index >= measurable.length) return;
      const mutant = measurable[index].mutant;

      const mutated = applyEdits(sources, mutant);
      const touched = [...new Set(mutant.edits.map((e) => e.file))];
      for (const f of touched) await Deno.writeTextFile(`${work}/${f}`, mutated.get(f)!);

      const dirs = testDirs(mutant);
      // Narrow to the tests that actually execute the mutated lines, when the profile
      // knows them. `null` means it does not, and the full scope runs — see profile.ts
      // for why that fallback is the safe direction.
      //
      // The fallback is not the whole scope in *discovery* order any more. Handing `deno test` a
      // directory lets it choose, and it chooses alphabetically, so the cheap in-process suites
      // end up behind the ones that spawn real clients. `--fail-fast` only pays when the killer
      // runs early, so the same files go in cheapest-first instead.
      let runDirs = scopeFiles.get(dirs.join(" ")) ?? dirs;
      let filter: string | undefined;
      let notCovered = false;
      if (profile) {
        const locs = mutant.edits.flatMap((e) => linesOf(e.file, e.start, e.end));
        const picked = selectTests(profile, locs);
        if (picked === null) widened++;
        if (picked !== null) {
          if (picked.length === 0) {
            notCovered = true;
          } else {
            const f = filterFor(picked);
            const files = [...new Set(picked.map((t) => profile!.home.get(t)!))].sort();
            if (f && files.every(Boolean)) { filter = f; runDirs = byCost(files, profile); narrowed++; }
            else widened++;
          }
        }
      }
      if (notCovered) {
        results.push({
          index, mutant, killed: false, timedOut: false, dirs, notCovered: true,
          detail: "no test executes this line",
        });
        console.log(`  --  ${mutant.name.padEnd(52)} not covered`);
        for (const f of touched) await Deno.writeTextFile(`${work}/${f}`, sources.get(f)!);
        continue;
      }
      const cmd = testCommand(work, runDirs, filter);
      const child = cmd.spawn();
      let timedOut = false;
      // The full scope's baseline, not the narrowed run's: a narrowed run is a subset and therefore
      // faster, so this errs towards a longer deadline, which is the safe direction for a scoring
      // rule that counts a timeout as a kill.
      const deadline = deadlineFor(baselineMs.get(dirs.join(" ")) ?? 0);
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }, deadline);
      const { code, stdout, stderr } = await child.output();
      clearTimeout(timer);

      const output = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
      // A timeout counts as killed: an infinite loop is a detected defect, not a silent one.
      const killed = timedOut || code !== 0;
      const firstFail = output.split("\n").find((l) => l.includes("FAILED") || l.includes("error"));
      results.push({
        index,
        mutant,
        killed,
        timedOut,
        dirs,
        detail: timedOut ? `timed out after ${(deadline / 1000).toFixed(0)}s` : (firstFail ?? "").trim().slice(0, 90),
      });
      const mark = timedOut ? "TO " : killed ? "ok " : "!! ";
      console.log(`  ${mark} ${mutant.name.padEnd(52)} ${killed ? "killed" : "SURVIVED"}`);

      for (const f of touched) await Deno.writeTextFile(`${work}/${f}`, sources.get(f)!);
    }
  };
  await Promise.all(workDirs.map(worker));
  // Workers finish out of order, so the report is not allowed to depend on arrival.
  results.sort((a, b) => a.index - b.index);
} finally {
  // Tolerate a directory already being gone. It should never be, but a crash here
  // discards a run's entire report after the work has been done, which is a bad trade
  // for a cleanup step.
  for (const d of workDirs) await Deno.remove(d, { recursive: true }).catch(() => {});
}

// ── Report ────────────────────────────────────────────────────────────────────

if (unmeasurable.length > 0) {
  console.log(`\n${unmeasurable.length} mutant(s) excluded: their tests do not pass unmutated.`);
  console.log("  Not counted as killed, because nothing about them was measured.");
  for (const t of unmeasurable.slice(0, 10)) console.log(`  - ${t.mutant.name}`);
  if (unmeasurable.length > 10) console.log(`  ... and ${unmeasurable.length - 10} more`);
}

if (profile) {
  const total = narrowed + widened + results.filter((r) => r.notCovered).length;
  console.log(
    `\nselection: ${narrowed}/${total} mutant(s) ran only the tests that reach them, ` +
    `${widened} fell back to the full scope`);
}

const uncovered = results.filter((r) => r.notCovered);
if (uncovered.length > 0) {
  console.log(`\n${uncovered.length} mutant(s) on lines no test executes.`);
  console.log("  Not killed, and not the same thing as a survivor: a survivor means the tests");
  console.log("  ran and noticed nothing, this means nothing ran. The fix is a test, not a");
  console.log("  better assertion.");
  for (const r of uncovered.slice(0, 12)) console.log(`  - ${r.mutant.name}`);
  if (uncovered.length > 12) console.log(`  ... and ${uncovered.length - 12} more`);
}

const controls = results.filter((r) => r.mutant.mustSurvive);
const real = results.filter((r) => !r.mutant.mustSurvive);
const survivors = real.filter((r) => !r.killed);
const knownWhy = new Map(KNOWN_SURVIVORS.map((k) => [k.name, k.why]));
const documented = survivors.filter((r) => knownWhy.has(r.mutant.name));
const realSurvivors = survivors.filter((r) =>
  !r.mutant.ratioOnly && !r.mutant.equivalent && !knownWhy.has(r.mutant.name));
const ratioSurvivors = survivors.filter((r) => r.mutant.ratioOnly);
const claimedEquivalent = survivors.filter((r) => r.mutant.equivalent && !r.mutant.ratioOnly);

// Validate the harness before reporting anything about the implementation.
const notNoop = controls.filter((r) => controlIsNoop.get(r.mutant.name) !== true);
if (notNoop.length > 0) {
  console.log(`\nHARNESS BROKEN: ${notNoop.length} control mutation(s) changed the emitted wasm.`);
  console.log("A control is supposed to be a no-op — a comment edit. One that alters the binary");
  console.log("is testing something, so it cannot serve as the check that a clean run survives.");
  for (const r of notNoop) console.log(`  - ${r.mutant.name}`);
  Deno.exit(2);
}

const brokenControls = controls.filter((r) => r.killed);
if (brokenControls.length > 0) {
  console.log(`\nHARNESS BROKEN: ${brokenControls.length} no-op control mutation(s) were reported killed.`);
  console.log("Every other result in this run is meaningless — a staged project is failing to");
  console.log("build or run for a reason unrelated to the mutation.");
  for (const r of brokenControls) console.log(`  - ${r.mutant.name}: ${r.detail}`);
  Deno.exit(2);
}

const killedCount = real.filter((r) => r.killed).length;
console.log(`\n${killedCount}/${real.length} mutants killed` +
  (controls.length > 0
    ? `  (${controls.length} control(s) survived, and TCE independently confirmed each is a no-op)`
    : ""));
console.log(
  `discarded before running: ${equivalent.length} provably equivalent, ` +
  `${duplicate.length} duplicate, ${invalid.length} uncompilable`);
console.log(
  "  Equivalent and duplicate mutants are excluded from the score rather than counted as\n" +
  "  killed. Counting them is what inflates a mutation score: a duplicate is the same\n" +
  "  experiment twice, and an equivalent mutant is one no test could ever kill.");

if (equivalent.length > 0) {
  console.log(`\n${equivalent.length} mutant(s) compiled to byte-identical wasm (TCE-equivalent):`);
  for (const t of equivalent.slice(0, 12)) console.log(`  - ${t.mutant.name}`);
  if (equivalent.length > 12) console.log(`  ... and ${equivalent.length - 12} more`);
}

if (invalid.length > 0) {
  console.log(`\n${invalid.length} mutant(s) did not compile — excluded, not counted as killed:`);
  for (const t of invalid.slice(0, 12)) {
    console.log(`  - ${t.mutant.name}: ${(t.triage as { detail: string }).detail}`);
  }
  if (invalid.length > 12) console.log(`  ... and ${invalid.length - 12} more`);
}

// A documented survivor that gets killed means its argument has stopped holding.
const staleKnown = real.filter((r) => r.killed && knownWhy.has(r.mutant.name));
if (staleKnown.length > 0) {
  console.log(`\n${staleKnown.length} mutant(s) listed in known.ts were killed:`);
  for (const r of staleKnown) {
    console.log(`  - ${r.mutant.name}\n      the recorded reason no longer holds; drop the entry`);
  }
}

if (documented.length > 0) {
  console.log(`\n${documented.length} generated survivor(s) documented in known.ts:`);
  for (const r of documented) console.log(`  - ${r.mutant.name}\n      ${knownWhy.get(r.mutant.name)}`);
}

if (claimedEquivalent.length > 0) {
  console.log(`\n${claimedEquivalent.length} survivor(s) documented as unobservable:`);
  for (const r of claimedEquivalent) {
    console.log(`  - ${r.mutant.name}\n      ${r.mutant.equivalent}`);
  }
}

if (ratioSurvivors.length > 0) {
  console.log(`\n${ratioSurvivors.length} ratio-only survivor(s) — expected, the suite allows ratio slack:`);
  for (const r of ratioSurvivors) console.log(`  - ${r.mutant.name}`);
}

if (broken.length > 0) {
  console.log(`\n${broken.length} curated mutation(s) could not be located — the patterns are stale.`);
  console.log("  A mutation that does not apply is not a passing result; it is a test that stopped");
  console.log("  running. Update the pattern or delete the mutation.");
}

if (realSurvivors.length > 0) {
  console.log(`\n${realSurvivors.length} SURVIVING mutant(s) — untested behaviour:`);
  for (const r of realSurvivors) {
    console.log(`  - ${r.mutant.name}   [tested against ${r.dirs.join(", ")}]`);
    for (const e of r.mutant.edits) {
      console.log(`      ${e.file}: ${e.was.slice(0, 66)}`);
      console.log(`      ->            ${e.replacement.slice(0, 66)}`);
    }
  }
}

if (realSurvivors.length > 0 || broken.length > 0 || staleKnown.length > 0) Deno.exit(1);
console.log("\nno surviving correctness mutants");
