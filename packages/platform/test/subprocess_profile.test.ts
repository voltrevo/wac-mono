// A test that runs a built program is attributable, not invisible.
//
// wac-mono 0024. Mutation testing narrows "run the whole suite" to "run the tests that reach this
// line" by reading wac's coverage counters either side of each test — in the test's *own* process. A
// test that builds a binary and runs it as a child has its counters in the child, so it contributed
// nothing, and the profile could not tell "this test reaches no lines" from "this test was never
// measured". `packages/sh`, where every test works that way, narrowed **0 of 117** mutants.
//
// The chain being checked here has four links and each one is somewhere different: `build.ts` makes an
// instrumented build when `WAC_PROFILE` is set, `host/entry.ts` dumps the counters after `main`,
// `harness/wacProfile.ts` collects whatever appeared while a test was running, and the profile JSON
// carries it. A unit test of any single link would pass while the chain was broken — the dump
// directory is spelled in two files that do not import each other, which is exactly the kind of
// agreement that rots — so this drives the whole thing: a real profile run over a real test file that
// only ever talks to a subprocess.

import { COV_DUMP_DIR } from "../build.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

/** A test file that builds a program and runs it as a child, and does nothing else. */
const SUBJECT = `
import { buildApp } from "${new URL("../build.ts", import.meta.url).href}";

const bin = await Deno.makeTempFile({ prefix: "wac-profiled-" });
await buildApp("packages/platform/example/wc.wac", bin, { read: true });

Deno.test("the built program counts the lines in a file", () => {
  const r = new Deno.Command(bin, {
    args: ["packages/platform/example/wc.wac"],
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  if (r.code !== 0) throw new Error(new TextDecoder().decode(r.stderr));
  const out = new TextDecoder().decode(r.stdout).trim();
  if (!/^\\s*\\d+\\s+\\d+\\s+\\d+/.test(out)) throw new Error(\`unexpected output: \${out}\`);
});
`;

Deno.test("a subprocess-only test file produces a profile with lines in it", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wac-subprof-" });
  const subject = `${dir}/subject.test.ts`;
  const profile = `${dir}/profile`;
  await Deno.writeTextFile(subject, SUBJECT);
  // Dumps from an unrelated run would be credited to this test's baseline and prove nothing. Cleared
  // rather than isolated: the directory is baked into a build, so it cannot be moved per run.
  try {
    await Deno.remove(COV_DUMP_DIR, { recursive: true });
  } catch {
    // Not there, which is the ordinary state.
  }
  try {
    const r = await new Deno.Command(Deno.execPath(), {
      args: ["test", "--allow-all", subject],
      env: { WAC_PROFILE: profile },
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

    const names = Object.keys(p.tests);
    assertEquals(names.length, 1, `expected one test, got ${JSON.stringify(names)}`);
    const lines = p.tests[names[0]];

    // The claim: this test reaches lines, and they are the ones the program actually ran. Before the
    // change it reached none — and "none" was indistinguishable from "not measured", which is why the
    // count is asserted rather than merely that the key exists.
    // Ten is a floor, not a measurement: `wc.wac` is a small program and this run attributes twenty of
    // its lines. What the floor is there for is the difference between "some" and "none" — before the
    // change this was zero, and zero was indistinguishable from "not measured".
    assertEquals(lines.length >= 10, true, `only ${lines.length} lines attributed: ${lines.slice(0, 5)}`);
    assertEquals(
      lines.some((l) => l.includes("wc.wac")),
      true,
      `nothing from the program under test: ${lines.slice(0, 8).join(", ")}`,
    );
    // `all` has to carry the child's instrumented lines too, or a reader cannot tell a line no test
    // reaches from a line that has no counter — they want opposite responses.
    assertEquals(
      p.all.some((l) => l.includes("wc.wac")),
      true,
      "the profile does not know which lines exist in the child",
    );
    assertEquals(p.all.length >= lines.length, true, `${p.all.length} known, ${lines.length} hit`);

    // And the dumps are taken away as they are read: one left behind would be credited to every later
    // test in the file as well, which is a profile that says everything reaches everything.
    const leftover = (() => {
      try {
        return [...Deno.readDirSync(COV_DUMP_DIR)].filter((e) => e.name.endsWith(".json")).length;
      } catch {
        return 0;
      }
    })();
    assertEquals(leftover, 0, `${leftover} dump(s) left behind`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an ordinary build is not instrumented, and says so in its shebang", async () => {
  // The other half: instrumentation is a test artefact. A coverage build carries a scoped
  // `--allow-write` for the dump directory, and an ordinary one must not — a program's shebang is what
  // an auditor reads, and a capability that appears only under an environment variable would be the
  // worst possible place for one to hide.
  const { buildApp } = await import("../build.ts");
  const plain = await Deno.makeTempFile({ prefix: "wac-plain-" });
  const instrumented = await Deno.makeTempFile({ prefix: "wac-cov-" });
  try {
    await buildApp("packages/platform/example/wc.wac", plain, { read: true }, "deno", false, {
      coverage: false,
    });
    await buildApp("packages/platform/example/wc.wac", instrumented, { read: true }, "deno", false, {
      coverage: true,
    });
    const first = async (p: string) => (await Deno.readTextFile(p)).split("\n")[0];
    assertEquals((await first(plain)).includes("--allow-write"), false, await first(plain));
    assertEquals(
      (await first(instrumented)).includes(`--allow-write=${COV_DUMP_DIR}`),
      true,
      await first(instrumented),
    );
    // Scoped, not blanket: the difference between "may write its counters" and "may write".
    assertEquals((await first(instrumented)).includes("--allow-write "), false, await first(instrumented));
  } finally {
    await Deno.remove(plain);
    await Deno.remove(instrumented);
  }
});
