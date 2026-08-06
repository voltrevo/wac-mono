// A test written in wac is attributable, not invisible.
//
// wac-mono 0090, and the same shape as 0024 one layer over: mutation testing narrows "run the whole
// suite" to "run the tests that reach this line" by reading wac's coverage counters either side of each
// test. `wacTestRun` — which registers 64 of this repo's test files — compiled without instrumentation
// and never imported `wacProfile`, so it wrapped no `Deno.test` and wrote no profile at all. Every line
// reached *only* by a wac-written test was therefore known (some other file's instrumented build
// contributed it) and covered by nothing, and the runner reads that as "nothing executes this": the
// mutant is recorded without being run and excluded from the score.
//
// `packages/std` scored 2 of 8 that way, with `i32Eq` called untested by four cases that build a `Map`
// with it. Under-selection is a wrong verdict; over-selection is only slow.
//
// So this drives the whole chain rather than any link of it: a real profile run over a real wac-written
// test file, asserting that lines of the *library* it exercises land in that test's own set.

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

/** A test file that registers wac-written tests and does nothing else — the shape 64 files have. */
const SUBJECT = `
import { wacTestRun } from "${new URL("./wacTestRun.ts", import.meta.url).href}";
await wacTestRun("packages/std/test/wac/map_test.wac", "map");
`;

Deno.test("a wac-written test file attributes the library lines it runs", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wac-testprof-" });
  const subject = `${dir}/subject.test.ts`;
  const profile = `${dir}/profile`;
  await Deno.writeTextFile(subject, SUBJECT);
  try {
    const r = await new Deno.Command(Deno.execPath(), {
      args: ["test", "--no-check", "--allow-all", "--quiet", subject],
      env: { ...Deno.env.toObject(), WAC_PROFILE: profile },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const dec = new TextDecoder();
    const said = `${dec.decode(r.stdout)}${dec.decode(r.stderr)}`;
    assertEquals(r.code, 0, `the subject run failed:\n${said}`);

    const written = [...Deno.readDirSync(profile)].map((e) => e.name);
    assertEquals(written.length, 1, `expected one profile, got ${JSON.stringify(written)}`);
    const p = JSON.parse(await Deno.readTextFile(`${profile}/${written[0]}`)) as {
      all: string[];
      tests: Record<string, string[]>;
    };

    // Per test, not merely present in the file. Attribution is the whole point: a profile that credits
    // every line to every test is the same as having no profile, and one that credits none — which is
    // what this path did — is worse, because it reads as a measured absence.
    const names = Object.keys(p.tests);
    assertEquals(names.length > 0, true, "the wac tests registered but were not wrapped");

    // A line of `hash.wac`, which the map's own tests reach only by constructing a `Map` with it. This
    // is the exact line 0090 was filed about, so the regression it guards is the one that happened.
    const equality = (l: string) => l.startsWith("packages/std/src/hash.wac:");
    assertEquals(
      p.all.some(equality),
      true,
      "the instrumented build does not know hash.wac exists — was it compiled with coverage?",
    );
    const byTest = names.filter((n) => p.tests[n].some(equality));
    assertEquals(
      byTest.length > 0,
      true,
      `no test is credited with a hash.wac line; ${names.length} tests, ` +
        `${p.tests[names[0]]?.length ?? 0} lines in the first`,
    );

    // And the library under test, not only the test file: a profile of the test's own lines would
    // select nothing useful, since mutants are made in `src`.
    assertEquals(
      p.tests[byTest[0]].some((l) => l.startsWith("packages/std/src/map.wac:")),
      true,
      "the test's set has no lines from the module it exercises",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
