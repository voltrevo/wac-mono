// Which tests to run for a given mutant, from a per-test coverage profile.
//
// A mutation on line 300 of x509.wac cannot be noticed by a test that never executes line
// 300. Running the whole package suite for every mutant spends most of a sweep proving
// that repeatedly. This builds the map once — test name to the set of source lines it
// executes — and hands the runner the handful of tests that could possibly react.
//
// The profile comes from `harness/wacProfile.ts`, which wraps `Deno.test` and diffs the
// coverage counters around each test body. Building it costs one instrumented run per
// test file and is cached against a hash of the sources, so it is paid once per edit
// rather than once per mutant.
//
// ## Two rules that keep this from producing wrong answers
//
// **A line with no coverage point is never narrowed.** Not every line carries an
// instrumented point — the coverage build models branches, not statements — so "no test
// covers this line" and "this line is not a coverage point" look identical in the data
// and mean opposite things. Narrowing on the second selects nothing and scores the mutant
// as a survivor without running anything. So selection only applies when the line is
// known to the profile; otherwise the full scope runs, exactly as before.
//
// **A line covered by nothing is reported, not silently skipped.** That case is real and
// worth seeing: it separates "tests ran and noticed nothing" from "no test executes this
// line at all", which are different problems with different fixes and which today's
// single "survivor" verdict conflates.

import { refuseIfNested, SUITE_ENV } from "../suiteGuard.ts";

// wac-mono 0077: this spawns whole test runs, so it must not be one.
refuseIfNested("the mutation profiler");

export type Profile = {
  /** "file:line" to the tests that execute it. */
  lines: Map<string, string[]>;
  /** Every line the profile knows about, so an unknown line can be told from an unhit one. */
  known: Set<string>;
  /** Test name to the file that defines it, for building the run command. */
  home: Map<string, string>;
  testFiles: string[];
  /**
   * How long each test file took, in milliseconds, measured while profiling.
   *
   * Free to collect — the profile already runs every file once, on its own — and it is what
   * lets the runner put the cheap files first. With `--fail-fast`, the order decides how much
   * of a scope a killed mutant actually pays for, and Deno's own discovery order is
   * alphabetical, which in `packages/ssh` puts the one in-process suite behind two that each
   * spawn a real OpenSSH client.
   */
  cost: Map<string, number>;
};

type Raw = { entry: string; all: string[]; tests: Record<string, string[]> };

/**
 * Test files cheapest first, so `--fail-fast` stops early as often as possible.
 *
 * Ordering only ever changes *when* a verdict is reached, never what it is: a killed mutant is
 * killed by whichever test notices, and every file still runs when nothing does. That is what
 * makes this safe where narrowing is not — under-selection is a wrong answer, a bad order is
 * only a slow one.
 *
 * An unmeasured file sorts last rather than first. If the profile never ran it, the honest
 * assumption is that it is the expensive or awkward one.
 */
export function byCost(files: string[], profile: Profile | undefined): string[] {
  const sorted = [...files].sort();
  if (profile === undefined) return sorted;
  return sorted.sort((a, b) => {
    const ca = profile.cost.get(a) ?? Number.POSITIVE_INFINITY;
    const cb = profile.cost.get(b) ?? Number.POSITIVE_INFINITY;
    return ca === cb ? a.localeCompare(b) : ca - cb;
  });
}

/** Every test file under the given package directories. */
export async function testFilesIn(dirs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const d of dirs) {
    const walk = async (p: string) => {
      try {
        for await (const e of Deno.readDir(p)) {
          const q = `${p}/${e.name}`;
          if (e.isDirectory) await walk(q);
          else if (e.name.endsWith(".test.ts")) out.push(q);
        }
      } catch { /* a directory that does not exist contributes nothing */ }
    };
    await walk(d);
  }
  return out.sort();
}

/**
 * Run each test file once with the profiler attached and read back what it covered.
 *
 * Sequentially and without `--parallel`: the profiler diffs one global counter array
 * around each test body, so two tests running at once would each be credited with the
 * other's lines. Files are independent processes, so this is about tests within a file.
 */
export async function buildProfile(
  work: string,
  testFiles: string[],
  log: (s: string) => void,
): Promise<Profile> {
  const dir = await Deno.makeTempDir({ prefix: "wac-profile-" });
  const cost = new Map<string, number>();
  try {
    for (const f of testFiles) {
      const began = performance.now();
      const cmd = new Deno.Command("deno", {
        args: ["test", "--no-check", "--allow-read", "--allow-write", "--allow-run",
               "--allow-net", "--allow-env", "--quiet", f],
        cwd: work,
        env: { WAC_PROFILE: dir, ...SUITE_ENV },
        stdout: "piped",
        stderr: "piped",
      });
      const { code } = await cmd.output();
      // Timed even when it fails: a file that dies early is cheap, and ordering it first costs
      // nothing. The number is only ever used to sort.
      cost.set(f, performance.now() - began);
      // A file that fails while profiling still contributes whatever it covered before
      // it failed. The baseline check is what decides whether a red suite is usable; this
      // is only attribution.
      if (code !== 0) log(`  profile: ${f} exited ${code}; using partial coverage`);
    }

    const lines = new Map<string, string[]>();
    const home = new Map<string, string>();
    const known = new Set<string>();
    for await (const e of Deno.readDir(dir)) {
      if (!e.name.endsWith(".json")) continue;
      const raw = JSON.parse(await Deno.readTextFile(`${dir}/${e.name}`)) as Raw;
      const file = raw.entry.replace(/^.*\/wac-mono\//, "");
      // `known` is every instrumented line, so a line that is in it with no tests means
      // "nothing executes this" rather than "the instrumentation does not model this".
      for (const p of raw.all ?? []) known.add(p);
      for (const [test, pts] of Object.entries(raw.tests)) {
        home.set(test, file);
        for (const p of pts) {
          if (!lines.has(p)) lines.set(p, []);
          lines.get(p)!.push(test);
        }
      }
    }
    return { lines, known, home, testFiles, cost };
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/**
 * The tests that could react to a mutation at these lines.
 *
 * `null` means "cannot narrow, run everything in scope" — either the profile does not
 * know the line, or a name cannot be expressed as a filter. An empty array means the
 * profile knows the line and no test reaches it.
 */
export function selectTests(p: Profile, locations: string[]): string[] | null {
  const picked = new Set<string>();
  let anyKnown = false;
  for (const loc of locations) {
    if (!p.known.has(loc)) continue;
    anyKnown = true;
    for (const t of p.lines.get(loc) ?? []) picked.add(t);
  }
  // *Any* known line, not every one. A mutation spans a whole syntactic construct — an
  // `extreme` mutant replaces an entire function body — and most interior lines are plain
  // statements the coverage build does not model, since it instruments branches. Requiring
  // every line to be known meant one unmodelled statement discarded the whole selection,
  // which is how 83 of 235 mutants ended up running the full scope for no reason.
  //
  // Sound because control enters a construct through its entry: a test that executes an
  // interior line must have reached the line that dominates it, and that is the line
  // carrying the point. Verified the only way that counts — the verdicts are unchanged.
  if (!anyKnown) return null;
  // Selecting on *any* known line is fine; concluding "nothing executes this" from it is
  // not. An edit span need not contain the line its coverage point sits on — a function
  // whose signature wraps has its entry point above where the span begins — so a span can
  // hold known-but-uncovered interior lines while the covered entry is outside it. Read
  // literally that says no test reaches the function, and `extreme/tls/client/
  // tlsClientInit` was reported exactly that way for a function every client test calls.
  //
  // So the empty answer is only trusted when every line of the span is accounted for.
  // Otherwise fall back, which costs time and cannot be wrong.
  if (picked.size === 0 && !locations.every((l) => p.known.has(l))) return null;
  return [...picked].sort();
}

/** A `--filter` that matches exactly these test names and nothing else. */
export function filterFor(names: string[]): string | null {
  if (names.length === 0) return null;
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Deno treats a value wrapped in slashes as a regex; anchoring makes it exact, so a
  // name that is a prefix of another cannot drag it in.
  return `/^(?:${escaped.join("|")})$/`;
}
