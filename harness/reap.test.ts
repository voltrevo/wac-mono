// Reaping, tested against a real orphan.
//
// wac-mono 0073. The property that matters is the safety one: a process is killed only when its command
// line matches *and* its parent is init. Getting that wrong means killing another agent's running server,
// so it is tested with an actual orphaned process rather than reasoned about — a shell that spawns a
// sleeper and exits, leaving the sleeper reparented to init, which is exactly the shape a killed test run
// leaves behind.
//
// The marker in the sleeper's command line is unique per run, so this can never match another agent's
// processes even if they are running this same test at the same moment.

import { findOrphans, reapOrphans } from "./reap.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

const alive = (pid: number): boolean => {
  try {
    // Signal 0 asks "does this process exist and may I signal it" without sending anything.
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch {
    return false;
  }
};

const settle = () => new Promise((r) => setTimeout(r, 150));

/** A sleeper whose parent has exited, so init has adopted it. Returns its pid. */
async function orphanSleeper(marker: string): Promise<number> {
  // `setsid` would also detach it; a double fork through `sh -c '… &'` is enough and needs no extra
  // binary. The parent shell exits immediately, and the sleeper is reparented.
  // `sleep 120 ${marker}` would be invalid — sleep refuses a second argument and exits immediately, which
  // the first version of this test did not notice because the pid it then watched was already dead. The
  // marker rides in a *shell's* command line, which survives for as long as the sleep it is waiting on.
  const spawned = new Deno.Command("sh", {
    // Redirected inside the shell, not just here: a backgrounded child inherits the piped stdout, so
    // `outputSync` waits for *its* end of the pipe. The first version of this took 2m06s — the whole
    // `sleep 120` — rather than the 150 ms it looks like.
    args: ["-c", `sh -c 'sleep 120 # ${marker}' >/dev/null 2>&1 & echo $!`],
    stdout: "piped",
    stderr: "null",
  }).outputSync();
  const pid = Number(new TextDecoder().decode(spawned.stdout).trim());
  // Wait for the parent shell to be gone, or the sleeper still has a live parent and is not yet an orphan.
  // Asked through `ps` for the same reason `reap.ts` uses it: `/proc/<pid>/stat` needs `--allow-all`.
  for (let i = 0; i < 40; i++) {
    await settle();
    const r = new Deno.Command("ps", { args: ["-o", "ppid=", "-p", String(pid)], stdout: "piped", stderr: "null" })
      .outputSync();
    if (new TextDecoder().decode(r.stdout).trim() === "1") return pid;
  }
  throw new Error(`sleeper ${pid} never became an orphan`);
}

Deno.test("an orphan matching the pattern is found and killed", async () => {
  const marker = `wac-reap-test-${crypto.randomUUID()}`;
  const pid = await orphanSleeper(marker);
  try {
    const found = findOrphans(new RegExp(marker));
    assertEquals(found.length, 1, `expected exactly the sleeper, got ${JSON.stringify(found)}`);
    assertEquals(found[0].pid, pid);

    const killed = reapOrphans(new RegExp(marker), "test sleeper");
    assertEquals(killed, 1);
    await settle();
    assertEquals(alive(pid), false, `pid ${pid} survived the reaping`);
  } finally {
    try {
      Deno.kill(pid, "SIGKILL");
    } catch {
      // Already reaped, which is the passing case.
    }
  }
});

Deno.test("a process with a live parent is never killed, however well it matches", async () => {
  // The safety property, and the one worth a real process: this is what another agent's running server
  // looks like, and killing it would be the worst outcome available here.
  const marker = `wac-reap-live-${crypto.randomUUID()}`;
  const child = new Deno.Command("sh", { args: ["-c", `sleep 120 # ${marker}`], stdout: "null", stderr: "null" })
    .spawn();
  try {
    await settle();
    assertEquals(findOrphans(new RegExp(marker)).length, 0, "a child of this test was called an orphan");
    assertEquals(reapOrphans(new RegExp(marker), "live sleeper"), 0);
    await settle();
    assertEquals(alive(child.pid), true, "a process with a live parent was killed");
  } finally {
    child.kill("SIGKILL");
    await child.status;
  }
});

Deno.test("a pattern that matches nothing reaps nothing and says nothing", () => {
  assertEquals(reapOrphans(/wac-reap-nothing-matches-this/, "nonexistent"), 0);
});
