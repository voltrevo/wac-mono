# 0070 — a redirection collects a child's whole output before writing the file

- **Status:** open
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
