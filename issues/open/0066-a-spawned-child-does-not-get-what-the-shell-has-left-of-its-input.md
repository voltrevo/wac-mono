# 0066 — a spawned child does not get what the shell has left of its standard input

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-a
- **Date:** 2026-08-04
- **Kind:** bug
- **Symptom:** wrong answer

## Reproduction

With `Shell.externalSpawnable` on, so that the shell's programs run as children:

```
wacsh -c '{ read a; cat; } <<EOF
one
two
three
EOF'
```

Expected, which is bash's:

```
two
three
```

Actual: nothing, exit 0. The `read` consumes `one` and the spawned `cat` receives no input at all rather
than the rest.

Called *in process* the same script is right, which is why this is invisible today: `packages/sh`'s own
twelve are called, and `packages/box`'s applets are spawned but its corpus has no compound with a
here-document and a `read` before the filter. This script *is* in `packages/sh`'s differential corpus —
it passes only because the program is called rather than spawned.

## Notes

The shell tracks what it has handed out — `restOfStdin()`, `ownsStdin`, `triedStdin` in `exec.wac` — and
`dispatch` passes `mayInherit`, so a child either *inherits* the real standard input or is *sent* the
bytes the shell holds:

- **inherited** (`inheritIn` true): the child reads the process's own input. Right for `wacsh -c 'cat'`,
  and what makes `cat; cat` see one line between them rather than one each (issue 0042).
- **sent**: the shell has the bytes — a here-document, a pipeline stage's output, or the remainder after
  its own `read` — and pushes them into the child's input queue.

The second is what is not happening. Either `mayInherit` is true when the shell is holding a
here-document, so the child inherits a real stdin that is empty, or the remainder is never sent.
`runSimple`'s handling of `ownsStdin` beside `collectChild` is where to start.

Blocks the second half of
[0061](0061-sh-applets-return-all-their-output-at-once-so-a-large-stage-dies.md): the shell cannot spawn
its own programs until this and [0065](0065-a-spawned-programs-arguments-are-not-byte-exact.md) are
fixed, and spawning is what lets `head` stop `seq`.
