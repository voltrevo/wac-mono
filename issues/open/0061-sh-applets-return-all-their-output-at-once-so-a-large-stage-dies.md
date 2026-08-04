# 0061 — `sh`'s applets return all their output at once, so a large stage dies instead of streaming

- **Status:** open
- **Reported by:** agent-a
- **Date:** 2026-08-04
- **Kind:** bug
- **Symptom:** trap

## Reproduction

Build `packages/sh/src/sh.wac` and ask for more output than fits in a wasm array:

```sh
seq 1 2000000000 | head -1     # bash prints 1 and stops; this dies
seq 1 2000000000 > out         # …and it is not the pipeline: the same, on its own
```

Expected: `1`, in the time it takes to write one line — bash's `seq` streams and takes SIGPIPE when
`head` stops reading.

Actual, after about five seconds:

```
error: requested new array is too large
```

The status is 70, which is the runtime's for a trap rather than anything the shell decided.

## Notes

The cause is the seam's signature, documented in `packages/sh/README.md` as the design decision it
is: `Output run(Cli cli, string cwd, Vec<string> argv, u8[] stdin)` — bytes in, bytes out. `seq` is eleven lines and every
one of them is right for that shape:

```wac
Buf out = Buf.create();
for (i32 i = from; i <= to; i++) { out.pushAll(itoa(i).toBytes()); out.push(10); }
return Output.ok(out.take());
```

Nothing can move until the loop ends, so:

- **A downstream that stops reading cannot stop its producer.** Pipeline *stages* do run at once
  now (`canStream` in `exec.wac`), each in its own worker, and that is not the missing piece: the
  producer has produced nothing to be back-pressured about until it has produced all of it.
- **The bound is memory, and it is announced as a trap.** "requested new array is too large" names
  a wasm limit rather than the program's problem, and it arrives instead of the first line rather
  than after some of it.

`packages/box` already has the shape that fixes this. Its applets write through `Sink` (64 KiB
blocks, `bytes`/`line`/`flush`, each returning whether to keep going), which is what lets its `yes`
terminate against a `head`. Moving `program.wac` to it means changing every applet's signature and
every caller of the seam — thirteen programs, `dispatch`, `trySelf`, `collectChild`, and the SSH
server that runs commands through the same seam — which is why this is filed rather than done in
passing. It is a package boundary and a shared-suite-wide change, not a fix in the file I was in.

Two decisions belong to whoever takes it, and neither is obvious:

1. **What replaces `found`.** The status and the found flag are separate today because a shell says
   127 for "no such command" and the program's own code for "ran and failed". A streaming applet
   still has to answer both, and it has to answer "no such command" *before* it writes anything.
2. **What a write refusal means.** `Sink`'s methods return "keep going", which an applet must
   actually check; `seq` checking it is the whole SIGPIPE behaviour, and `seq` ignoring it is the
   present bug with extra steps.

Until then the README says what happens, in the section that used to claim pipelines ran one stage
at a time.

## Half done, 2026-08-04 (agent-a)

**The programs stream now**, and one of the two reproductions above is fixed:

```
seq 1 2000000000 | head -1     ->  1, in 0.13s   (was: five seconds, then a trap)
seq 1 20000000 | wc -l         ->  20000000, in 2.9s
seq 1 2000000 | tail -1        ->  2000000, in 0.36s, holding one line
```

What that took:

- `Sink` and `Feed` moved into `packages/platform` (with the line reader, `Lines`), because box had them
  and sh could not use them — box depends on sh. One implementation, and `box/src/lib/out.wac` and
  `lib/reader.wac` are deleted rather than left to drift.
- The seam is `(Feed in, Sink out, Sink err) -> i32` and `run` keeps its old signature by passing
  *buffering* sinks, so a shell that cannot spawn behaves exactly as before. One body per program serves
  both ways of being run, which is what a collecting sink is for.
- `seq` writes as it counts and **checks the answer**, so a refused write stops it. `head` reads lines
  and stops at `n`. `tail` keeps a ring of `n` rather than the whole input.
- A child's output queue now *waits* for room instead of refusing when it is merely full. Full and gone
  were one answer, and a producer told to stop when it should have waited truncated `seq … > out` to
  276 MB, silently, with status 0. `end()` still refuses, which is how `head -1` stops `seq`.

**What is left is the second reproduction**, `seq 1 2000000000 > out`, and it is now a loud trap rather
than a silent truncation. Two things block it, both platform bugs that the shell's twelve exposed rather
than caused, and both filed:

- [0065](0065-a-spawned-programs-arguments-are-not-byte-exact.md) — a non-UTF-8 argument does not survive
  a spawn.
- [0066](0066-a-spawned-child-does-not-get-what-the-shell-has-left-of-its-input.md) — a spawned child
  does not receive the shell's remaining standard input.

`packages/sh/src/sh.wac` is a multi-call program now — `wacsh seq 1 5` runs `seq` — so the only thing
standing between here and the fix is `sh.externalSpawnable = true`, which is present and commented out
with those two issue numbers. With it on, two differential scripts disagree with bash; with it off, the
twelve are called in process as before.

Beyond those: a redirection collects a spawned child's output in the shell before writing the file, so
`> out` is bounded by memory even once spawning works. `openOutput` is the capability for that, and
`packages/box`'s `cp` and `split` already use it.
