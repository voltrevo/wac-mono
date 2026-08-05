# 0076 — an app worker runs `main` once, so a test pays a fresh one per case

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-c
- **Date:** 2026-08-05
- **Kind:** performance
- **Symptom:** not implemented

`harness/appRun.ts` runs a built application in the test's own process instead of spawning it, by
being the launcher half that `spawnChild` already expects. Measured on `packages/box`, `cat` over a
small file, with byte-identical output and the same exit code:

| | |
| --- | --- |
| as a subprocess | 112ms |
| as a worker in this process | **64ms** |

That is where it stops, because **`main` runs once per worker.** `runAsWorker` in
`packages/platform/host/entry.ts` awaits one start message, calls
`app.main(coreOf(b, app), cliOf(b, app))`, posts the result and returns. So every case is a new
worker, which re-parses a 372 KB bundle and recompiles the wasm — and that is the 64ms.

The file's own comment anticipates this:

> `main(Core, Cli) -> i32` is the whole contract. It was a struct with `start` and `run` first,
> which bought nothing: a program that runs once and exits has no state to keep between calls, so
> the struct was ceremony around a function. A **service, called repeatedly, will want the struct —
> and can have it then.**

This is the "then".

## What it would take

`runAsWorker` loops instead of running once: take a start message, run `main`, post the result,
wait for the next. Each run needs its own world — a fresh bridge, or the same bridge re-pointed at
new argv, standard input and output queues — which is what the launcher already builds per child.

The saving is the bundle parse and the wasm compile, paid once instead of per case. A rough shape
of the prize: `packages/box`'s widest differential test makes about 48 runs, so 48 × 64ms becomes
one 64ms start plus 48 much cheaper calls.

## What has to be decided, which is why this is an issue

**Whether `main` may be called twice in one instance.** It is safe only if a program keeps no state
across calls. wac has no mutable module-level state, so that is true today by construction — but it
is a property being *relied on* rather than merely observed, and it should be written down as part
of the contract rather than assumed by a test harness.

**What a service looks like from wac.** The comment above says a struct with `start` and `run`. If
that is the eventual shape, a repeated-`main` loop is a stopgap that will be replaced, and it may be
better to go straight to the struct.

## Notes

The saving is real but modest on its own: `packages/box`'s widest test went 13s → 8s from the
process-to-worker change alone. Worth pairing with whatever else touches that test, rather than
doing for its own sake.

`harness/appRun.ts` is deliberately *not* isolation — the worker shares the process and is handed a
world built by the test, the same authority a spawned child gets from its parent. Tests that are
about process boundaries still build an executable, and `packages/platform/test/spawn.test.ts` is
the one that must keep doing so.
