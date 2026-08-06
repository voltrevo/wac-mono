// A child that will never finish fails, and one that is merely slow does not.
//
// wac-mono 0082. A wedged child used to hang whoever ran it: the push gate's 45-minute timeout spent on
// no information, or Deno's `has been running for over (4m0s)` naming the test and none of its cases. A
// hang is the worst possible failure because it costs the most and says the least.
//
// **What makes this safe to decide, when the same issue argues that clocks should not decide anything:**
// the conclusion is not "it took too long". It is "the bridge's counters and slot states are byte for
// byte what they were two checks ago, and there is a call outstanding". A slow machine still moves —
// `sweeps` climbs, `done` climbs, slots change hands. A deadlocked one is frozen. That is a state, not a
// duration, and the duration only decides how long to look before believing it.
//
// The two cases below are the two halves of that claim, and the second is the one that keeps this honest:
// a program that computes for a long time with no host call outstanding must never be failed.

import { appRunner } from "./appRun.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

Deno.test("a child waiting for an answer that never comes is reported, not waited on", async () => {
  // The wedge, built rather than waited for: standard input is a capability the *host* serves, so a
  // world that never answers `RECV` is a child parked in `Atomics.wait` for ever — the same shape the
  // corpus hits about once in fifty runs on an idle machine.
  //
  // `WAC_STALL_MS` keeps the test to a few seconds. The default is 45s, so a real run has to be
  // genuinely stuck for over a minute before this fires.
  Deno.env.set("WAC_STALL_MS", "700");
  try {
    const sh = await appRunner("packages/sh/src/sh.wac", { read: true, write: true, env: true });
    const began = performance.now();
    let said = "";
    try {
      // `read` blocks on standard input, and `endStdin: false` means nothing will ever release it —
      // the shell submits `RECV(h=0)` and waits for bytes or an end that are not coming. That is the
      // same state the corpus reaches about once in fifty runs on an idle machine, built deliberately.
      await sh.run(["-c", "read line; echo $line"], { endStdin: false });
      throw new Error("the run returned instead of reporting a deadlock");
    } catch (e) {
      said = e instanceof Error ? e.message : String(e);
    }
    const took = performance.now() - began;
    assertEquals(said.includes("deadlocked"), true, `wrong failure: ${said}`);
    assertEquals(said.includes("0082"), true, `the message does not say where to read: ${said}`);
    // It names what was outstanding, which is the whole point — a failure that says only "deadlocked"
    // leaves the next person exactly where this issue started.
    assertEquals(/RECV|running:/.test(said), true, `the message does not name the wait: ${said}`);
    assertEquals(took < 10_000, true, `took ${Math.round(took)}ms to conclude`);
  } finally {
    Deno.env.delete("WAC_STALL_MS");
  }
});

Deno.test("a program that is merely busy is never called deadlocked", async () => {
  // The half that keeps the detector honest. `seq 1 300000 | wc -l` does real work with host calls in
  // flight the whole time, so its state changes between checks even at a 500ms budget. If this ever
  // fails, the detector is looking at elapsed time rather than at progress, and every long-running
  // program in the repo is about to start failing.
  Deno.env.set("WAC_STALL_MS", "500");
  try {
    const sh = await appRunner("packages/sh/src/sh.wac", { read: true, write: true, env: true });
    const r = await sh.run(["-c", "seq 1 300000 | wc -l"], {});
    assertEquals(r.code, 0, r.err);
    assertEquals(r.out.trim(), "300000");
  } finally {
    Deno.env.delete("WAC_STALL_MS");
  }
});
