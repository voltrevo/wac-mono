// The exclusive lane says who is in it and why.
//
// A file that declares `// test-lane: exclusive — why` is run alone, after the parallel pass. That is a
// real cost — the suite pays it in wall time, sequentially, every run — and it is the kind of cost that
// grows quietly: a test that is merely *flaky* is easier to move into the lane than to fix, and a lane
// with twenty files in it is a serial suite with extra steps.
//
// So the lane is countable, and each member has to give a reason. Neither of these can prove a file
// belongs there; what they do is make the answer to "why is the suite slow?" visible in one place, and
// stop the reason being the empty string.

import { exclusiveTests, laneSplit } from "../harness/testLane.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

Deno.test("every exclusive test says why it needs the machine", async () => {
  const lane = await exclusiveTests();
  const mute = lane.filter((e) => e.why.length < 12);
  assertEquals(
    mute.map((e) => e.file).join(", "),
    "",
    `these declared themselves exclusive without saying why:\n  ${
      mute.map((e) => e.file).join("\n  ")
    }\nWrite the reason after the dash — the next person deciding whether to add a fourth file to the ` +
      `lane needs to know what the first three were for.`,
  );
  // Printed on every green run, because a serial lane that nobody counts is how a parallel suite
  // becomes a sequential one by accident.
  console.log(`  ${lane.length} file(s) in the exclusive lane:`);
  for (const e of lane) console.log(`    ${e.file} — ${e.why}`);
});

Deno.test("the lane is small enough to still be a lane", async () => {
  // Not a law of nature, and deliberately loose. What it catches is the drift where "run it alone"
  // becomes the standard answer to a flaky test: at that point the right move is to fix the test or the
  // design, and the number is there to make somebody say so out loud rather than raising it again.
  const lane = await exclusiveTests();
  assertEquals(
    lane.length <= 6,
    true,
    `${lane.length} files want the machine to themselves. That is a sequential suite wearing a lane; ` +
      `fix the tests or the design rather than raising this number.`,
  );
});

Deno.test("no targets means everything, which is where this was wrong the first time", () => {
  // `deno task test` passes no targets and lets discovery find the files; `test:changed` does the same
  // when a shared file changed. Reading that as "nothing matches" left the gate's lane working and the
  // other entry point silently running the same files four-at-a-time — the exact inconsistency the lane
  // exists to remove.
  const declared = ["packages/ssh/test/cli.test.ts", "packages/ssh/test/server.test.ts"];
  assertEquals(laneSplit([], declared).alone.length, 2, "empty targets should mean the whole tree");
});

Deno.test("a directory target contains the files declared under it", () => {
  // The first version compared a directory against a file path with `Set.has`, so nothing ever matched
  // and the lane was inert. Prefixes, not equality.
  const declared = ["packages/ssh/test/cli.test.ts", "packages/box/test/box.test.ts"];
  assertEquals(
    laneSplit(["packages/ssh/"], declared).alone.join(","),
    "packages/ssh/test/cli.test.ts",
  );
  assertEquals(laneSplit(["packages/json/"], declared).alone.length, 0, "an unrelated package");
  assertEquals(
    laneSplit(["packages/ssh/", "packages/box/"], declared).alone.length,
    2,
    "two targets, both with a declared file",
  );
});
