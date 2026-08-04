# 0038 — a pipeline gathers each stage's output instead of running the stages at once

- **Status:** open
- **Claimed by:** agent-a
- **Reported by:** agent-a
- **Date:** 2026-08-04
- **Kind:** missing feature
- **Symptom:** wrong answer

`runPipeline` hands each stage's *whole* output to the next:

```wac
u8[] carried = u8[0]();
for (i32 i = 0; i < pipeline.stages.len(); i++) {
  carried = runCommand(sh, pipeline.stages.get(i), carried, last);
}
```

So a pipeline is a sequence, not a pipeline. Measured in the browser shell demo:

| command | time |
|---|---|
| `seq 1 10 \| head -1` | 52 ms |
| `seq 1 200000 \| head -1` | **11.8 s** |
| `seq 1 200000 \| wc -l` | 13.6 s |

`head -1` taking twelve seconds is the whole bug: it waits for all 200,000 lines to be produced and
buffered. A real shell returns immediately, because `head` closing its input is what stops `seq`.

`yes | head -1` does end — in 275 ms — but for the wrong reason: the buffer that holds a child's
output caps at 8 MiB (`platform/host/child.ts`), `write` starts answering false, and `yes` is written
to stop when it does. A cap, not a closed pipe.

## What has to be true first, and now is

Streaming needs the stages to run at the same time, which needs each stage to be a real program:

- `spawn` exists on all three hosts, from one implementation.
- `spawnSelf` runs *this* program again with different arguments, so a browser tab has programs at
  all — `box sort` is `box` reading its first argument.
- `sh` uses that: `trySelf` runs an applet as a child rather than calling it, when the program it is
  part of dispatches those names.
- `Core.waitAny(ids, millis)` already watches several handles at once, which is what a shuttle needs.

So the pieces are here. What remains is the pipeline itself.

## The shape

Start every stage, then move bytes between them until each has ended:

- each stage that is a real program gets a handle; `send` to the next stage's input, `recv` from the
  previous stage's output, `waitAny` over all of them
- a stage that is *not* spawnable — a builtin, a function, a compound, a subshell — still has to
  gather at its own boundary, because it is a function call inside the shell. That boundary should be
  visible rather than silent: `{ echo a; } | rev` gathering is fine, `seq | head` gathering is the
  bug.
- `head` closing its input has to reach the producer as a failed `write`, which is what already stops
  `yes` at the cap. Ending a child's input is `closeFeed`; stopping it outright is `closeSocket`.

## Notes

`collectChild` in `sh/src/exec.wac` is where a stage is gathered today, and its header says so.

Not only a browser question: under Deno the same pipeline gathers, because box's applets were called
in process there too. One fix serves both, which is the point of doing it in `sh` rather than in a
host.
