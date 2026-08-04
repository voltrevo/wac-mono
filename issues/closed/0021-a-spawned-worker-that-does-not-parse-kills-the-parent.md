# 0021 — a spawned worker whose source does not parse kills the parent

- **Status:** closed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-b
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** trap

`cli.spawn(source, args)` hands `source` to a `Worker`. When the source is not valid JavaScript
the worker throws at load, and that error is **not** contained: it propagates into the parent,
which dies with exit 1 and Deno's own message on stderr. The parent never gets a chance to see it
as a failed child.

`Child.error` exists for exactly this and stays empty — the handle comes back non-negative,
because the worker *was* created. The failure happens afterwards, and there is nowhere for it to
be reported.

## Reproduction

```sh
deno task app:build packages/sh/src/sh.wac --allow-read --allow-write --allow-env -o /tmp/sh
mkdir -p /tmp/wp && printf 'this is not javascript {{{\n' > /tmp/wp/bad
/tmp/sh -c 'WACPATH=/tmp/wp; bad; echo still-here'
```

Expected: the shell reports that `bad` could not be executed, gives it a status, and goes on to
print `still-here` — which is what a shell does with a file that is not a program.

Actual: `still-here` is never printed. The shell exits 1 with

```
error: Uncaught (in worker "") SyntaxError: Expected ';', '}' or <eof>
error: Uncaught (in promise) Error: Unhandled error in child worker.
```

Neither line comes from the shell. The `Uncaught (in promise)` one is the parent dying.

## Notes

Found while wiring `packages/sh` to `spawn`, which is now the shell's route to a real external
command. This is the first thing a shell hits, because *any* file on the search path that is not a
worker bundle takes this path — the shell cannot know what it has until it tries, and there is no
executable bit to consult.

`packages/sh/test/spawn.test.ts` has a test named after this issue that asserts the **current**
behaviour, so it will fail loudly when this is fixed. Change it to expect 126 then; the shell side
already produces 126 for a `Child` that comes back with `handle < 0`, so a fix that populates
`Child.error` instead of throwing needs nothing from `sh`.

Two things I checked so it does not have to be rechecked:

- **It is not about the shell.** `packages/platform/example/pipe.wac` given the same file dies the
  same way, and that program is platform's own.
- **It is the load, not the protocol.** A bundle that parses but never speaks the bridge protocol
  does *not* kill the parent — it hangs instead, which is a different problem and arguably
  0018's (no timeout on a handle).

The fix is presumably an `onerror`/`onmessageerror` handler on the `Worker` in
`packages/platform/host/children.ts` that resolves the child's ticket as a failure rather than
letting the error escape. Whether a worker that dies *later* should surface through `exitCode` as
negative is the same question and probably the same handler.

## Still live, 2026-08-03 (agent-a)

Reproduces exactly as written. The shell dies and `still-here` never prints:

```
error: Uncaught (in promise) Error: Unhandled error in child worker.
```

More reachable than when it was filed: the browser terminal and `box`'s `bin/sh.wac` are shells
people are meant to type into, and `$WACPATH` is one `export` away from being set. A file that is
not a worker bundle is the ordinary case — anything built without `--worker`, or a text file with
the right name — so this is a trap a user can walk into rather than a wrong answer a program has to
be written to hit.

## Closed, 2026-08-04 (agent-a)

`worker.onerror` existed and was an *observer*: without `preventDefault()` Deno re-raises a worker's
error as the parent's own uncaught error, so the handler ran, resolved the exit code as -1, and the
parent died anyway. One line is the difference between handling an event and watching it.

That alone would have left `Child.error` empty, because the handle was answered before the failure
happened. So `spawn` now waits for the source to *load* before it answers:

- `entry.ts` posts `{ready: true}` from the worker as soon as the bundle evaluates — before the
  bridge arrives and before the application runs. It is the one fact a parent cannot otherwise
  learn.
- `children.ts` exposes `loaded`, resolved by whichever comes first: the notice, the load error, the
  child finishing, or a 500 ms grace. The grace resolves as **alive**, never as failed: a bundle
  built before `ready` existed, or a slow load on a busy machine, must not be reported as a program
  that would not start.
- The Deno host's `SPAWN` awaits it and answers `-1` plus the reason instead of a handle, in the
  same shape a handle already had, so the worker-side decoder reads one i32 and takes the rest as
  the message.

`packages/sh` needed nothing, as predicted: `handle < 0` was already 126, distinct from the 127 of
not existing. The reproduction now reads

```
sh: notaprogram: SyntaxError: Expected ';', '}' or <eof>
still-here
```

First line only in `Child.error` — a worker's `SyntaxError` arrives with a code frame, which is
several lines and belongs on a terminal rather than after `sh: name: `. Nothing is lost: the child's
own isolate has already printed the whole of it, which is also the one part of this that cannot be
fixed from the parent. `preventDefault` stops the propagation, not the child's own report, so stderr
carries two accounts of one failure and only the second is the shell's. `platform/test/spawn.test.ts`
asserts both, so if Deno ever stops printing its own, there is a test to notice.

Tests: `packages/platform/test/spawn.test.ts` for the platform (the issue was right that this is not
about the shell — platform's own `runner.wac` died the same way), and two in
`packages/sh/test/spawn.test.ts`, one of which is the old test flipped to expect what it should.

What is *not* fixed, and was already named here: a file that parses but never speaks the protocol
hangs instead of failing. Measured identical before and after this change, and now filed as
[0033](0033-a-file-that-parses-but-is-not-a-worker-bundle-wedges-the-shell.md) with the reason the
obvious fix — treating a missing `ready` as a failure — trades a hang for false failures under load.
