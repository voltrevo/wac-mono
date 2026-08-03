# 0021 — a spawned worker whose source does not parse kills the parent

- **Status:** open
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
