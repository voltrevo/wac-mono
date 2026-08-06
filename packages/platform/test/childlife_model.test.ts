// Every order the runtime can deliver a child's fate in, and what must hold in all of them.
//
// The queue is enumerable now (`queue_model.test.ts`), so a stream that never ends is not a queue bug —
// it is `end()` never being called, which happens here. wac-mono 0082's wedge is a parent blocked reading
// a child whose stream nobody ended, so this is the layer it lives in.
//
// A child's events arrive from a worker, a timer and the caller, and none of them is ordered against the
// others: `ready` can arrive after `grace`, `error` after `result`, `kill` at any moment, and any of them
// twice. That is four sources of nondeterminism a test run samples one path through.
//
// The invariants below are each a way a caller hangs or is lied to. The two that matter most:
//
//   - **once the child is gone, its streams are ended.** Absent that, a parent waits for bytes that
//     cannot come — the wedge, exactly.
//   - **the exit settles after the shutdown, never before.** `harness/appRun.ts` drains before it waits
//     because the output queues are capped; an exit that beats the shutdown is a caller reading a stream
//     nobody will end.

import { type LifeEffect, type LifeEvent, type LifeState, newborn, step } from "../host/childLife.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

type Transition = (state: LifeState, event: LifeEvent) => { state: LifeState; effects: readonly LifeEffect[] };

const EVENTS: ReadonlyArray<{ show: string; event: LifeEvent }> = [
  { show: "ready", event: { kind: "ready" } },
  { show: "result(ok)", event: { kind: "result", ok: true, code: 0 } },
  { show: "result(threw)", event: { kind: "result", ok: false, code: 0 } },
  { show: "error", event: { kind: "error", message: "the worker died" } },
  { show: "grace", event: { kind: "grace" } },
  { show: "kill", event: { kind: "kill" } },
];

type Broken = { rule: string; path: string[]; detail: string };

/** Walk every ordering of the events, repeats included, to `depth`. */
function enumerate(depth: number, go: Transition): Broken[] {
  const broken: Broken[] = [];

  const walk = (state: LifeState, path: string[], settled: { loaded: number; exit: number }): void => {
    if (path.length === depth || broken.length > 0) return;
    for (const { show, event } of EVENTS) {
      const { state: after, effects } = go(state, event);
      const here = [...path, show];
      const counts = { loaded: settled.loaded, exit: settled.exit };
      let shutdownAt = -1;
      let exitAt = -1;

      effects.forEach((e, i) => {
        if (e.do === "settleLoaded") counts.loaded++;
        if (e.do === "settleExit") {
          counts.exit++;
          exitAt = i;
        }
        if (e.do === "shutdown") shutdownAt = i;
      });

      const fail = (rule: string, detail: string) => broken.push({ rule, path: here, detail });

      if (counts.loaded > 1) {
        fail("`loaded` settled more than once", `${counts.loaded} times`);
        return;
      }
      if (counts.exit > 1) {
        fail("`exit` settled more than once", `${counts.exit} times`);
        return;
      }
      // The one the wedge is about: a child that is gone with its streams still open leaves whoever is
      // reading them waiting for bytes that cannot come.
      if (after.exited !== null && !after.shutDown) {
        fail("the child exited without its streams being ended", `code ${after.exited}`);
        return;
      }
      // And in that order, because `appRun` drains before it waits on the exit.
      if (exitAt >= 0 && shutdownAt >= 0 && exitAt < shutdownAt) {
        fail("the exit settled before the shutdown", `exit at ${exitAt}, shutdown at ${shutdownAt}`);
        return;
      }
      if (after.exited !== null && after.loaded === null) {
        fail("the child exited while `loaded` was still unsettled", "a caller awaiting load would hang");
        return;
      }

      walk(after, here, counts);
    }
  };

  walk(newborn(), [], { loaded: 0, exit: 0 });
  return broken;
}

Deno.test("every order a child's fate can arrive in leaves the caller released", () => {
  // 6^5 = 7,776 orderings, repeats included, each checked at every step.
  const broken = enumerate(5, step);
  assertEquals(
    broken.length === 0,
    true,
    broken.length === 0
      ? ""
      : `${broken[0].rule}\n  path: ${broken[0].path.join(" → ")}\n  ${broken[0].detail}`,
  );
});

Deno.test("a `ready` after the grace does not un-settle anything", () => {
  // The specific ordering that a loaded machine produces: the readiness deadline fires, and the child —
  // which was only slow — reports ready a moment later. `loaded` has already been settled with a
  // complaint; the child then runs and exits normally, and the caller must see one settle of each.
  const a = step(newborn(), { kind: "grace" });
  assertEquals(a.effects.filter((e) => e.do === "settleLoaded").length, 1);
  const b = step(a.state, { kind: "ready" });
  assertEquals(b.effects.filter((e) => e.do === "settleLoaded").length, 0, "settled twice");
  const c = step(b.state, { kind: "result", ok: true, code: 0 });
  assertEquals(c.state.exited, 0);
  assertEquals(c.state.shutDown, true, "the streams must be ended even on this path");
});

Deno.test("the invariants catch a shutdown that forgets the streams", () => {
  // The mutant that is the wedge, stated: a child whose exit settles without its streams being ended.
  // If the enumeration passes this, the test above proves nothing about the thing 0082 is about.
  const forgetful: Transition = (state, event) => {
    const real = step(state, event);
    if (event.kind !== "result") return real;
    return {
      state: { ...real.state, shutDown: state.shutDown },
      effects: real.effects.filter((e) => e.do !== "shutdown"),
    };
  };
  const broken = enumerate(4, forgetful);
  assertEquals(broken.length > 0, true, "a child that exits with its streams open went unnoticed");
  assertEquals(
    broken[0].rule,
    "the child exited without its streams being ended",
    `caught the wrong thing: ${broken[0].rule}`,
  );
  console.log(`  the wedge's shape, found by: ${broken[0].path.join(" → ")}`);
});

Deno.test("and one that settles the exit before ending the streams", () => {
  // The subtler half: everything is ended, but in the wrong order, so a caller that drains after waiting
  // reads a queue that is still open. `appRun` drains first precisely because of the cap, and this is
  // what would break if that were ever rearranged.
  const backwards: Transition = (state, event) => {
    const real = step(state, event);
    const shutdown = real.effects.filter((e) => e.do === "shutdown");
    const rest = real.effects.filter((e) => e.do !== "shutdown");
    return { state: real.state, effects: [...rest, ...shutdown] };
  };
  const broken = enumerate(4, backwards);
  assertEquals(broken.length > 0, true, "the order of shutdown and exit went unchecked");
  assertEquals(broken[0].rule, "the exit settled before the shutdown", `caught: ${broken[0].rule}`);
});
