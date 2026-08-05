// Every program in this repo compiles.
//
// wac-mono 0079: the suite compiled only the programs a test drives — `packages/box` and `packages/sh`
// build theirs per case — and none of the other thirty. So a program could stop compiling and
// `deno task test` stayed green, with the breakage surfacing whenever somebody next tried to run it and
// no indication of which change had done it. It was found by consolidating a function out of
// `packages/tor/src/relayd.wac`: the tor package's 169 tests passed, and the only reason the program was
// known to still build is that somebody built it by hand afterwards.
//
// **A compile is the whole assertion.** This is not a behavioural test and does not need to be. It calls
// `wacCompile` rather than `buildApp`, which skips the two `deno bundle` subprocesses a real build runs —
// measured at **4.3 seconds for all 35 programs**, against roughly a second each for full builds. That is
// what makes it affordable inside the suite rather than a separate task somebody has to remember.
//
// The programs come from `harness/programs.ts`, which is also what writes `MAP.md`. One definition, so a
// program cannot be in the map and outside this test.

import { wacCompile } from "wac/wacCompile.ts";
import { findPrograms } from "../harness/programs.ts";
import { wacFiles } from "../harness/wacFiles.ts";

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
 * A floor on how many programs were found, so the test cannot pass by finding none.
 *
 * The count is 35 today across twelve packages. Asserting a floor rather than the exact number keeps this
 * from failing every time somebody writes a program — the exact count lives in `MAP.md`, which is
 * regenerated and checked by `tools/map.test.ts`.
 */
const AT_LEAST = 30;

Deno.test("every program in the repo compiles", async () => {
  const programs = await findPrograms();
  assertEquals(
    programs.length >= AT_LEAST,
    true,
    `only ${programs.length} programs found — the discovery in harness/programs.ts is broken, and a ` +
      `test that compiles nothing passes`,
  );

  const broken: string[] = [];
  for (const program of programs) {
    const files = await wacFiles(program.path);
    const r = wacCompile(files, program.path);
    if (r.ok) continue;
    // Every diagnostic, not the first: a program that stopped compiling because a shared function moved
    // usually says so several times, and the second line is often the one that names the cause.
    broken.push(
      `${program.path} (${program.kind}, ${program.pkg}):\n` +
        r.diagnostics.slice(0, 6).map((d) => `    ${d.file}:${d.line}:${d.col} ${d.message}`).join("\n"),
    );
  }

  assertEquals(
    broken.join("\n"),
    "",
    `${broken.length} of ${programs.length} programs do not compile:\n  ${broken.join("\n  ")}`,
  );
});

Deno.test("a program's entry point is one of the two the platform dispatches", async () => {
  // Guards the guard. `harness/programs.ts` decides what a program is by looking for `main` or `page`,
  // and the platform's two launchers decide what to *run* the same way. If those ever disagree, this test
  // compiles the wrong set and the failure it exists to catch goes back to being silent.
  //
  // Two files, because the dispatch is split and the first version of this test looked in one: `main` is
  // run by `entry.ts`, and `page` only by `entryBrowser.ts` — a page needs a canvas, so the Deno launcher
  // has nothing to offer it.
  const entry = await Deno.readTextFile("packages/platform/host/entry.ts");
  assertEquals(entry.includes("app.main"), true, "entry.ts no longer runs `main`");
  const browser = await Deno.readTextFile("packages/platform/host/entryBrowser.ts");
  assertEquals(
    /\bpage\b/.test(browser),
    true,
    "entryBrowser.ts no longer mentions `page`, so `harness/programs.ts` may be looking for the wrong " +
      "export",
  );
  const programs = await findPrograms();
  const kinds = new Set(programs.map((p) => p.kind));
  assertEquals(kinds.has("cli"), true, "no `main` program found");
  assertEquals(kinds.has("page"), true, "no `page` program found");
});
