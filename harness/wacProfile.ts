// Which tests execute which lines, recorded per test rather than per file.
//
// Mutation testing runs every mutant against every test in scope, and most of those
// tests cannot possibly notice: a mutation on line 300 of x509.wac is invisible to a test
// that never executes line 300. Knowing which tests reach a line turns "run the package's
// whole suite" into "run the four tests that touch this", which is where most of a sweep's
// time goes.
//
// ## How the attribution works
//
// `wacBind` in profile mode compiles with coverage instrumentation and registers the
// module here. This file wraps `Deno.test` — which is patchable, and `wacBind` is imported
// at the top of every test file, so the wrapper is installed before any test registers —
// and reads the counter array either side of each test body.
//
// The counters are cumulative and are never reset. That is deliberate: attribution is by
// *numeric delta*, `after[i] > before[i]`, not by "was this point hit by now". Resetting,
// or comparing sets of hit points, would credit a line to the first test that reached it
// and to no other — so a line covered by four tests would select one, and a mutant on it
// would be scored against a quarter of the tests that could kill it. Under-selection is
// a wrong verdict, not a slow one.
//
// ## What belongs to every test
//
// A test file's top-level code — the `await wacBind(...)`, any shared fixtures — runs
// before the first test. Its coverage belongs to all of them, so it is captured as a
// baseline when the first test starts and unioned into every test's set.
//
// ## Tests that run the code in another process
//
// A test that builds a binary and runs it as a child has its counters *in the child*, so none of the
// above sees them: for `packages/sh`, where every test works that way, mutation testing narrowed 0 of
// 117 mutants and could not tell "this test reaches no lines" from "this test was never measured".
//
// So a coverage build dumps what it executed into `COV_DUMP_DIR` — see `packages/platform/build.ts`,
// which makes instrumented builds whenever `WAC_PROFILE` is set, so no test had to be edited — and this
// file collects whatever appeared *during* a test and credits it to that test. Dumps are removed as
// they are read, so the next test does not inherit them.
//
// The child reports `file:line` rather than counter indices, so nothing here needs a copy of the point
// table and the two cannot disagree about what index 400 meant.
//
// ## Why this must not run in parallel
//
// One global counter array, read either side of a test body. Two tests interleaving would
// each be credited with the other's lines. Deno runs tests within a file sequentially
// unless `--parallel` is passed, and the profiler asserts that rather than trusting it.

export type ProfiledSource = {
  points: { file: string; line: number }[];
  counts(): number[];
};

/** Where to write the profile, or empty when not profiling. */
export const profileDir = (() => {
  try {
    return Deno.env.get("WAC_PROFILE") ?? "";
  } catch {
    return "";   // no --allow-env; profiling is off, which is the normal case
  }
})();

/** Where built programs leave their dumps. Duplicated from `build.ts` rather than imported, because
 * `harness/` must not depend on a package: the constant is one line and its definition is stated in
 * both places. If they ever disagree, this file silently collects nothing — so
 * `packages/platform/test/subprocess_profile.test.ts` asserts that a dump written by a real build is
 * found by a real profile run.
 */
const COV_DUMP_DIR = `${Deno.cwd()}/.cache/cov-dump`;

const sources: ProfiledSource[] = [];
const perTest = new Map<string, string[]>();
let baseline: string[] = [];
let started = false;
let installed = false;
let depth = 0;

/** Every instrumented point's hit count, summed per source line. */
function tally(): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sources) {
    const c = s.counts();
    s.points.forEach((p, i) => {
      const k = `${p.file}:${p.line}`;
      m.set(k, (m.get(k) ?? 0) + (c[i] ?? 0));
    });
  }
  return m;
}

const hitKeys = (m: Map<string, number>) => [...m].filter(([, n]) => n > 0).map(([k]) => k);

/** Every instrumented line a child reported, whether hit or not. Unioned into the profile's `all`. */
const childAll = new Set<string>();

/**
 * The lines executed by child processes since the last call, taking the dumps away as it reads.
 *
 * Read-and-remove rather than read-and-remember: a test is credited with what appeared while it ran,
 * and a dump left behind would be credited to every later test as well. Over-selection is only slow,
 * but a profile that says every test reaches every line is the same as having no profile.
 */
function drainChildDumps(): string[] {
  const hit: string[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(COV_DUMP_DIR)];
  } catch {
    return hit;   // nothing has dumped, which is the normal case
  }
  for (const e of entries) {
    if (!e.isFile || !e.name.endsWith(".json")) continue;
    const path = `${COV_DUMP_DIR}/${e.name}`;
    try {
      const d = JSON.parse(Deno.readTextFileSync(path)) as { all?: string[]; hit?: string[] };
      for (const line of d.all ?? []) childAll.add(line);
      for (const line of d.hit ?? []) hit.push(line);
    } catch {
      // A dump being written as this reads it: skipped, and left for the next drain rather than
      // removed. Losing one is over-selection at worst; deleting a half-written one loses it for good.
      continue;
    }
    try {
      Deno.removeSync(path);
    } catch {
      // Someone else got there first.
    }
  }
  return hit;
}

function install() {
  if (installed) return;
  installed = true;
  // deno-lint-ignore no-explicit-any
  const D = Deno as any;
  const orig = D.test.bind(Deno);

  // deno-lint-ignore no-explicit-any
  D.test = (a: any, b?: any, c?: any) => {
    const spec = typeof a === "object" && a !== null ? { ...a } : { name: a, fn: b ?? c };
    if (typeof spec.fn !== "function") return orig(a, b, c);
    const name: string = spec.name;
    const inner = spec.fn;

    // deno-lint-ignore no-explicit-any
    spec.fn = async (t: any) => {
      // Nested `t.step` calls re-enter; only the outermost body is a unit of attribution.
      if (depth > 0) return await inner(t);
      if (!started) {
        started = true;
        baseline = hitKeys(tally());
        // Anything a child dumped before the first test — a build step, a warm-up run — belongs to no
        // single test, so it goes in the baseline for all of them rather than to whoever ran first.
        for (const line of drainChildDumps()) baseline.push(line);
      }
      const before = tally();
      depth++;
      try {
        return await inner(t);
      } finally {
        depth--;
        const after = tally();
        const covered = new Set(baseline);
        for (const [k, n] of after) {
          if (n > (before.get(k) ?? 0)) covered.add(k);
        }
        // And whatever ran in another process while this test was running. There is no "before" to
        // subtract: a dump exists only because a child produced it since the last drain.
        for (const line of drainChildDumps()) covered.add(line);
        perTest.set(name, [...covered].sort());
      }
    };
    return orig(spec);
  };

  globalThis.addEventListener("unload", () => {
    if (perTest.size === 0) return;
    const entry = (Deno.mainModule ?? "unknown").replace(/^file:\/\//, "");
    const slug = entry.replace(/^.*\/wac-mono\//, "").replaceAll("/", "_");
    try {
      Deno.mkdirSync(profileDir, { recursive: true });
      // Every instrumented line, hit or not — not just the ones something reached.
      // Without this, "no test covers this line" and "this line has no coverage point"
      // are the same absence, and the reader cannot tell a testing gap from a limit of
      // the instrumentation. They want opposite responses.
      const all = new Set<string>(childAll);
      for (const src of sources) for (const p of src.points) all.add(`${p.file}:${p.line}`);
      Deno.writeTextFileSync(
        `${profileDir}/${slug}.json`,
        JSON.stringify({ entry, all: [...all].sort(), tests: Object.fromEntries(perTest) }),
      );
    } catch (e) {
      console.error(`profile write failed: ${e instanceof Error ? e.message : e}`);
    }
  });
}

/** Called by `wacBind` for each instrumented module it builds. */
export function registerProfiled(s: ProfiledSource): void {
  sources.push(s);
  install();
}

// **Installed on import when profiling, not only when a module registers.** `registerProfiled` is
// called by `wacBind`, and a test file that only builds binaries never calls it — which is exactly the
// case wac-mono 0024 is about. Such a file would have wrapped nothing and written no profile, so its
// tests would still have looked unmeasured. `harness/appRun.ts` and `packages/platform/build.ts` are
// imported by those files instead, and both pull this in.
if (profileDir !== "") install();
