// A spawned child's lifecycle, as a state machine.
//
// The queue in `./queue.ts` is now enumerable, so a stream that never ends is not a queue bug: it is
// `end()` never being *called*. That call lives here — in the sequence of things that can happen to a
// child between being spawned and being gone — and wac-mono 0082's wedge is a parent blocked reading a
// child whose stream nobody ended.
//
// The events are the four the runtime can deliver, in any order and possibly more than once:
//
//   - **ready** — the bundle evaluated and installed its message handler. It is a *fact a parent cannot
//     otherwise learn*: a source that is not JavaScript fails at load, and before this notice existed the
//     failure reached the parent as its own uncaught error and killed it (wac-mono 0021).
//   - **result** — `main` returned, or threw and was caught by the worker entry.
//   - **error** — the worker died: an uncaught throw, an out-of-memory, a terminate from outside.
//   - **grace** — the readiness deadline expired with no `ready`. Two minutes, because the alternative
//     asymmetry is worse: waiting longer costs a broken bundle seconds, waiting less costs a working
//     program a false accusation on somebody else's loaded machine.
//
// What must hold in *every* ordering is small and worth stating exactly, because each line is a way a
// caller hangs or lies:
//
//   - `exit` settles exactly once, and never before the streams are ended;
//   - `loaded` settles exactly once;
//   - once the child is gone in any way, the streams **are** ended and the responder **is** stopped —
//     that is the invariant whose absence is a parent waiting for bytes that cannot come;
//   - a `ready` that arrives after the grace timer does not un-settle anything.
//
// `spawnChild` in `./children.ts` drives this. The transition function is here so the orderings can be
// enumerated in `../test/childlife_model.test.ts` rather than sampled by whatever the scheduler happened
// to do.

/** What the runtime can deliver about a child. Any of them may arrive at any time, or twice. */
export type LifeEvent =
  | { readonly kind: "ready" }
  | { readonly kind: "result"; readonly ok: boolean; readonly code: number }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "grace" }
  | { readonly kind: "kill" };

export type LifeState = {
  /** Whether `ready` has been seen: it decides where a later failure's message belongs. */
  readonly started: boolean;
  /** Whether `loaded` has been settled, and with what — `""` means "it did load". */
  readonly loaded: string | null;
  /** The exit code, once decided. */
  readonly exited: number | null;
  /** Whether the streams have been ended and the responder stopped. */
  readonly shutDown: boolean;
};

/**
 * What the driver must do. `endStreams` is the one that matters most: it is the difference between a
 * parent that learns the child is gone and a parent that waits for ever.
 */
export type LifeEffect =
  | { readonly do: "settleLoaded"; readonly why: string }
  | { readonly do: "settleExit"; readonly code: number }
  | { readonly do: "shutdown" }
  | { readonly do: "sayOnStderr"; readonly line: string };

export type LifeStep = { readonly state: LifeState; readonly effects: readonly LifeEffect[] };

export const newborn = (): LifeState => ({ started: false, loaded: null, exited: null, shutDown: false });

/** One event, one step. Pure: no timers, no promises, no worker. */
export function step(state: LifeState, event: LifeEvent): LifeStep {
  const effects: LifeEffect[] = [];
  let next = state;

  /** `loaded` settles once. A second settle is not an error, it is a no-op — promises work that way. */
  const settleLoaded = (why: string) => {
    if (next.loaded !== null) return;
    next = { ...next, loaded: why };
    effects.push({ do: "settleLoaded", why });
  };

  /**
   * Ending a child: the streams close *and* the exit settles, in that order.
   *
   * Order matters to a caller that drains before it waits — which `harness/appRun.ts` does deliberately,
   * because the output queues are capped and reading only after the exit breaks any program that writes
   * more than the cap.
   */
  const finish = (code: number) => {
    if (next.exited !== null) return;
    // A child that is gone is a child whose load question is answered, whichever way it went. Leaving
    // `loaded` unsettled here is the hole this model found at depth one, and it is a caller that waits
    // for ever on a child that no longer exists.
    settleLoaded(next.started ? "" : "the child was killed before it reported ready");
    if (!next.shutDown) {
      next = { ...next, shutDown: true };
      effects.push({ do: "shutdown" });
    }
    next = { ...next, exited: code };
    effects.push({ do: "settleExit", code });
  };

  switch (event.kind) {
    case "ready":
      settleLoaded("");
      next = { ...next, started: true };
      break;

    case "result":
      // A result implies the bundle loaded, even if the notice was lost or overtaken.
      settleLoaded("");
      next = { ...next, started: true };
      // **A trap the child caught about itself.** The worker entry posts `{ok: false, error}` for
      // anything thrown out of `main`, and that used to be dropped here — the parent got -1 and no
      // reason, which is how `seq 1 200000000 | wc -c` printed nothing and exited 126 where bash prints
      // 1888888898. It goes on the child's standard error, labelled, because that is where a program's
      // diagnostics travel and what a shell already relays.
      if (!event.ok) effects.push({ do: "sayOnStderr", line: "wac: <result error>" });
      finish(event.ok ? event.code : -1);
      break;

    case "error":
      settleLoaded(event.message);
      // Before `ready`, the caller is still holding `loaded` and reports the message itself. After it,
      // nobody is listening for one — so the reason goes to the child's standard error rather than
      // nowhere, which is what it used to do.
      if (next.started) effects.push({ do: "sayOnStderr", line: `wac: ${event.message}` });
      finish(-1);
      break;

    case "grace":
      // The deadline is a *failure to load*, not a kill: a child that says nothing for two minutes has
      // not started, and `loaded` is how the caller finds out. If it has already loaded, this is stale.
      if (!next.started) settleLoaded("did not report ready within the grace");
      break;

    case "kill":
      // The caller gave up — `appRun`'s deadlock detector does this. The child must not outlive it, and
      // whoever was reading its streams must be released rather than left waiting on a dead worker.
      finish(-1);
      break;
  }

  return { state: next, effects };
}
