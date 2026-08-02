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

export type Profile = {
  /** "file:line" to the tests that execute it. */
  lines: Map<string, string[]>;
  /** Every line the profile knows about, so an unknown line can be told from an unhit one. */
  known: Set<string>;
  /** Test name to the file that defines it, for building the run command. */
  home: Map<string, string>;
  testFiles: string[];
};

type Raw = { entry: string; all: string[]; tests: Record<string, string[]> };

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
  try {
    for (const f of testFiles) {
      const cmd = new Deno.Command("deno", {
        args: ["test", "--no-check", "--allow-read", "--allow-write", "--allow-run",
               "--allow-net", "--allow-env", "--quiet", f],
        cwd: work,
        env: { WAC_PROFILE: dir },
        stdout: "piped",
        stderr: "piped",
      });
      const { code } = await cmd.output();
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
    return { lines, known, home, testFiles };
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
  for (const loc of locations) {
    if (!p.known.has(loc)) return null;      // unknown line: do not narrow
    for (const t of p.lines.get(loc) ?? []) picked.add(t);
  }
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
