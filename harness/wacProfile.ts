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
      const all = new Set<string>();
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
