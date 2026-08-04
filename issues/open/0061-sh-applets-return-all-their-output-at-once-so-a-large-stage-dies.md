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
