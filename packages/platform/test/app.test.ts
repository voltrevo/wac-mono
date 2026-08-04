// `deno task app` — build and run — and what happens when the launcher is killed.
//
// It spawns the built artifact as a child, so "kill the launcher" and "stop the application" are two
// different things unless something connects them. Nothing did: `packages/ssh`'s server tests started
// an sshd this way and killed the launcher afterwards, and each run left a server alive. That reached
// 57 orphaned servers and 13,736 zombie children against a container limit of 14,180 process ids,
// at which point unrelated commands began failing with `failed to create new OS thread` — and the
// tests passed the whole time. wac-mono issue 0017.
//
// The child is found by *looking for it in the process table*, which is the only check that answers
// the question. Asserting that the launcher exited proves nothing about what it left behind.

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
 * The *application's* command lines, by a marker in its arguments.
 *
 * `app.ts` is excluded, and that exclusion is the whole helper: the launcher's own command line carries
 * the same marker, so matching it made the first version of this test pass in 39 milliseconds — the
 * "application" it found was the launcher, and killing the launcher of course made it disappear. The
 * child is the built artifact in `/tmp`, which mentions neither `app.ts` nor `deno run`.
 */
function processesMatching(needle: string): string[] {
  const r = new Deno.Command("ps", { args: ["-eo", "args"], stdout: "piped", stderr: "null" })
    .outputSync();
  return new TextDecoder().decode(r.stdout)
    .split("\n")
    .filter((l) =>
      l.includes(needle) && !l.includes("app.ts") && !l.includes("-eo") && l.trim().length > 0
    );
}

/** Wait for a predicate, or give up — a bounded wait, so a failure is a failure and not a hang. */
async function until(what: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (what()) return true;
    await new Promise((res) => setTimeout(res, 100));
  }
  return what();
}

Deno.test({
  name: "killing `deno task app` stops the application it started — 0017",
  // The child is found in the process table, and the launcher builds a real artifact: both need the
  // whole permission set, and `run` most of all.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // A marker in the arguments, so the search cannot match another agent's copy of this test.
    const marker = `wac-orphan-probe-${Date.now()}`;
    const launcher = new Deno.Command("deno", {
      args: [
        "run",
        "-A",
        "packages/platform/app.ts",
        "packages/platform/example/waiter.wac",
        "--",
        marker,
      ],
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    try {
      // The application has to have *started* before killing anything, or the test would pass for the
      // wrong reason: a child that never ran is also a child that is not running afterwards. Its first
      // line is the signal, and the argument marker is what identifies it in the table.
      const started = await until(() => processesMatching(marker).length > 0, 60_000);
      assertEquals(started, true, "the application never appeared in the process table");

      launcher.kill("SIGTERM");
      await launcher.status;

      // And now it should be gone. Given a moment: the launcher forwards the signal, the child gets
      // it, and both of those are asynchronous.
      const gone = await until(() => processesMatching(marker).length === 0, 30_000);
      const left = processesMatching(marker);
      assertEquals(gone, true, `${left.length} process(es) outlived the launcher:\n${left.join("\n")}`);
    } finally {
      // Whatever happened, do not leave one behind — a failing test that leaks the thing it is about
      // would make the next run of the suite worse.
      for (const line of processesMatching(marker)) {
        const pid = line.trim().split(/\s+/)[0];
        void pid;
      }
      const stragglers = new Deno.Command("pkill", { args: ["-f", marker], stderr: "null" });
      try {
        stragglers.outputSync();
      } catch {
        // No `pkill` here, or nothing to kill. The assertion above is what reports the problem.
      }
      launcher.stdout.cancel().catch(() => {});
      launcher.stderr.cancel().catch(() => {});
    }
  },
});
