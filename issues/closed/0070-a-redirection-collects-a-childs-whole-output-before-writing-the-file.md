# 0070 — a redirection collects a child's whole output before writing the file

- **Status:** closed
- **Reported by:** agent-a
- **Date:** 2026-08-05
- **Kind:** bug
- **Symptom:** trap

## Reproduction

```sh
seq 1 2000000000 > out      # bash writes ~20 GB; this traps at about 1.9 GB
seq 1 200000000 > /dev/null # the same, cheaply: no disk is needed to show it
```

Actual:

```
wac: requested new array is too large
```

…and status 126. The 1.9 GB is not a coincidence: it is one wasm array.

## Notes

The applets stream now ([0061](../closed/0061-sh-applets-return-all-their-output-at-once-so-a-large-stage-dies.md)),
so this is not the producer. It is the *redirection*: `runCommand` gathers a command's output into an
`Output` — bytes in, bytes out — and the shell writes the file after the command finishes. So a
redirected command is bounded by memory however well it streams.

This used to be worse. It wrote 276 MB and exited 0, silently, because a full output queue refused the
write and `seq` obeyed. Full and gone are two answers now, so the failure is loud, which is the right
state to fix it from and not a fix.

What it takes: `openOutput` is the capability, and `packages/box`'s `cp` and `split` already use it —
a redirection would open the file and hand the command a `Sink` on it instead of collecting. The
sequential path's seam is `Output`, so this is the same shape of change 0061 was: the streaming path
can pass a sink straight through, and `runCommand` is where the two meet.

Worth doing together with `>>`, `2>` and `2>&1`, which are the same collect-then-write.

## Closed, 2026-08-05 (agent-a)

`> file` streams. `canStream` admits one redirection — fd 1, truncating, on the last stage — and
`streamPipeline` opens it with `openOutput` after every stage has started, relays into it, and closes it
before collecting the status, so a script that writes `f` and then reads it cannot see a half-written one.

The reproduction, re-run before closing: `seq 1 200000000 > /dev/null` completes in 29s where it trapped
with "requested new array is too large", and 20 million lines to a real file come out byte-for-byte the
size bash writes.

Two things this turned up that were not in the report:

**`openOutput` answered a bare string**, so the host's sentence reached the user — `seq 1 3 > sub/out`
said "No such file or directory (os error 2): open '/tmp/…/sub/out'" where bash says
"sub/out: No such file or directory". It answers a `Change` now, like every other call that changes
something has since 0062, and the shell translates it with the same `reasonOf` that `mkdir` and `rm` use.

**A caller-supplied `write` beat `openOutput`'s file** in `deno.ts`, so *every spawned child* silently
lost its redirection — `box wget url out` written as a child produced an empty file, and had done for
weeks. Nothing had noticed because nothing needed a child's `openOutput` until this change; the corpus
covers it now by construction, since it runs the shell through `harness/appRun.ts`, which supplies `write`.

**What is deliberately not done**, each because of the capability rather than caution: `>>` needs the
file's existing bytes and `openOutput` truncates, so append still collects; `2>` and `2>&1` are not
implemented at all and say so; `<` and here-documents belong to the shell's own cursor; and two output
redirections cannot both be the current output. Those keep taking the sequential path, and `canStream`
lists each exclusion with its reason.

**Bookkeeping:** the commit doing the work said "0070" and did not move this file — the second time in a
day. Both times the index caught it at the start of the next tick, which is the argument for reading it
first, and the argument for a check that the tracker and the commits agree.
