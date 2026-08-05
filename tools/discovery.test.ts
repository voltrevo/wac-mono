// No file in this repo may be *collectible as a test* without declaring one.
//
// `deno test` with no paths walks the working directory and imports every file matching
// `*_test.{ts,tsx,mts,js,mjs,jsx}`, `*.test.{…}` **or bare `test.{ts,js,mjs,mts}`** — and importing a
// module runs its top level. That last pattern is the one nobody remembers, and it cost a host reboot:
// `tools/test.ts`, a wrapper whose top level spawns `deno test --parallel`, was collected by the very
// suite it launches. Each generation reached the file after about a hundred seconds and started another
// generation; it was seventeen deep at load 122 on a machine three agents share, and unbounded.
//
// The recursion was invisible from inside. Every level's output was inherited by the same terminal, so
// the log looked like one very slow suite — 14,000 "ok" lines and no summary — and the process tree was
// the only place the truth showed. wac-mono 0077.
//
// So this test asserts the property that would have caught it before it ran: a file the runner will
// import is either a test file or a mistake.

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

/**
 * Deno's own discovery patterns, as of 2.9.
 *
 * Written out rather than imported because Deno does not export them, and stated as three separate
 * cases so the bare-`test.ts` one is impossible to skim past.
 */
function isCollected(name: string): boolean {
  const ext = /\.(ts|tsx|mts|js|mjs|jsx)$/;
  if (!ext.test(name)) return false;
  const stem = name.replace(ext, "");
  return stem.endsWith("_test") || stem.endsWith(".test") || stem === "test";
}

/** Directories the runner never walks, so what is in them cannot be collected. */
const SKIP = new Set([".git", "node_modules", ".cache", "dist", "target"]);

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    if (SKIP.has(e.name)) continue;
    const path = `${dir}/${e.name}`;
    if (e.isDirectory) yield* walk(path);
    else if (e.isFile) yield path;
  }
}

Deno.test("every file the test runner will import declares a test", async () => {
  const offenders: string[] = [];
  for await (const path of walk(".")) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (!isCollected(name)) continue;
    const source = await Deno.readTextFile(path);
    // Declaring a test is what makes an imported module a test rather than a script the runner happens
    // to execute. Two spellings count, and the second is not a loophole: `wacTestRun` registers a
    // `Deno.test` per exported `test_*` function in a wac file, so a file that calls it declares tests
    // by delegation — thirty-odd of this repo's test files are one line of exactly that.
    if (source.includes("Deno.test(") || source.includes("wacTestRun(")) continue;
    offenders.push(path);
  }
  assertEquals(
    offenders.join(", "),
    "",
    "these are imported and executed by `deno test` and declare no test — rename them, or give " +
      "them a test:\n  " + offenders.join("\n  "),
  );
});

Deno.test("the patterns this test relies on are the ones Deno actually uses", () => {
  // Guards the guard: if `isCollected` drifted from Deno's behaviour, the test above would pass while
  // measuring nothing. These four are the cases that matter, and the third is the one that bit.
  assertEquals(isCollected("thing_test.ts"), true);
  assertEquals(isCollected("thing.test.ts"), true);
  assertEquals(isCollected("test.ts"), true);
  assertEquals(isCollected("runTests.ts"), false);
  assertEquals(isCollected("testChanged.ts"), false);
  assertEquals(isCollected("cacheGuard.sh"), false);
});
