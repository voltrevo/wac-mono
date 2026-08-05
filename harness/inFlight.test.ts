// The pool, and the narration a wedge produces.
//
// wac-mono 0082. The behaviour worth testing is the one that only happens when something has gone wrong, so
// it is provoked here rather than waited for: a work item that never resolves, a `quietMs` of a few hundred
// milliseconds, and an assertion that the label of the stuck item appears in what was written. A narrator
// that stays silent in exactly the case it exists for is the failure mode, and it is invisible without this.

import { pool, watch } from "./inFlight.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a pool in a subprocess and return what it wrote to standard error.
 *
 * A subprocess rather than a captured file descriptor because this Deno has no `dup2`, and rather than an
 * injectable sink because an injected sink would not show that the narration reaches fd 2 at all — which is
 * the only property that matters here. The whole point is that a person watching a wedged suite sees it.
 *
 * `mode` picks which shape the child runs: one item that never finishes, or eight that are merely slow.
 */
async function narrationOf(mode: "wedge" | "slow"): Promise<string> {
  const here = new URL("./inFlight.ts", import.meta.url).href;
  const script = await Deno.makeTempFile({ prefix: "wac-inflight-", suffix: ".ts" });
  await Deno.writeTextFile(
    script,
    `import { pool } from ${JSON.stringify(here)};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
if (${JSON.stringify(mode)} === "wedge") {
  let release = () => {};
  const stuck = new Promise<void>((r) => (release = r));
  const running = pool(["a-quick-one", "the-one-that-wedges"], 2, async (label: string) => {
    if (label === "the-one-that-wedges") await stuck;
  }, { what: "script", quietMs: 300, label: (s: string) => s });
  // Long enough for the narrator to tick more than once, so "and again every quietMs" is covered too.
  await sleep(1100);
  release();
  await running;
} else {
  await pool(Array.from({ length: 8 }, (_, i) => i), 2, async () => {
    await sleep(120);
  }, { what: "slow", quietMs: 200 });
}
`,
  );
  try {
    const r = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--quiet", "--allow-env", script],
      stdout: "null",
      stderr: "piped",
    }).output();
    return new TextDecoder().decode(r.stderr);
  } finally {
    await Deno.remove(script);
  }
}

Deno.test("the pool returns results in the order the items went in", async () => {
  // Deliberately backwards: the last item finishes first, so a pool that returns completion order gets
  // this wrong and a pool that returns input order does not.
  const got = await pool([30, 20, 10, 0], 4, async (ms) => {
    await sleep(ms);
    return ms;
  }, { what: "sleep" });
  assertEquals(got.join(","), "30,20,10,0");
});

Deno.test("no more than `jobs` items are in flight at once", async () => {
  let now = 0;
  let peak = 0;
  await pool(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
    now++;
    peak = Math.max(peak, now);
    await sleep(5);
    now--;
  }, { what: "unit" });
  assertEquals(peak, 3, `peak concurrency was ${peak}`);
});

Deno.test("a throw in one item does not strand the pool", async () => {
  let ran = 0;
  await pool([1, 2, 3], 2, async (n) => {
    ran++;
    if (n === 2) throw new Error("this one fails");
    await sleep(1);
  }, { what: "unit" }).then(
    () => {
      throw new Error("the pool swallowed a failure");
    },
    (e) => assertEquals((e as Error).message, "this one fails"),
  );
  // The point is that the rejection arrives at all rather than hanging forever, which is what a `finally`
  // omitted around `done()` would cause. Deno's own timeout is the alternative detector, four minutes later.
  assertEquals(ran >= 2, true, `only ${ran} items started`);
});

Deno.test("a wedge names what it is holding, unprompted", async () => {
  const text = await narrationOf("wedge");
  assertEquals(
    text.includes("the-one-that-wedges"),
    true,
    `the stuck item was not named. stderr was:\n${text}`,
  );
  assertEquals(
    text.includes("a-quick-one"),
    false,
    `an item that finished was reported as in flight:\n${text}`,
  );
  assertEquals(text.includes("1 of 2 done"), true, `the counts are wrong:\n${text}`);
  assertEquals(text.split("script held").length - 1 >= 2, true, `it spoke once and gave up:\n${text}`);
});

Deno.test("work that finishes, however slowly, says nothing", async () => {
  // The other half of the clock's job: it must not narrate a machine that is merely slow, or it becomes
  // noise in every loaded run and gets ignored — which is how 0082's four wall-clock deadlines got their
  // authority in the first place.
  const text = await narrationOf("slow");
  assertEquals(text.trim(), "", `it narrated work that was progressing:\n${text}`);
});

Deno.test("`held` reports longest-first, so the wedge is the first line", async () => {
  const flight = watch("thing");
  try {
    const first = flight.start("started-first");
    await sleep(40);
    flight.start("started-second");
    const order = flight.held().map((h) => h.label);
    assertEquals(order.join(","), "started-first,started-second");
    assertEquals(flight.held()[0].heldMs >= 30, true, `held time was ${flight.held()[0].heldMs}ms`);
    first();
    assertEquals(flight.held().map((h) => h.label).join(","), "started-second");
    // Ending twice is not a miscount — a caller with both a `finally` and a happy-path call is fine.
    first();
    assertEquals(flight.held().length, 1);
  } finally {
    flight.stop();
  }
});
