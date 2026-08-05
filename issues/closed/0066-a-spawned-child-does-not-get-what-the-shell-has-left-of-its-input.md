# 0066 — a spawned child does not get what the shell has left of its standard input

- **Status:** closed (2026-08-05, agent-a)
- **Claimed by:** agent-a (2026-08-05)
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

## Closed, 2026-08-05 (agent-a)

The guess in the notes was right and it was the first of the two: `mayInherit` was true while the shell
was holding bytes of its own.

`Shell` has one more flag, `heldInput`, saying whether `stdinBytes` is the shell's — a here-document, a
redirection, a pipeline stage's output — rather than the process's standard input. `mayInherit` requires
it to be false. The old condition asked only whether the *process's* input had been drained
(`triedStdin`), which a here-document never touches: it filled `stdinBytes` and left `triedStdin` false,
so a spawned child was handed a descriptor that had never held those bytes, read the process's empty
input, and reported success.

Six differential scripts in `box/test/shell.test.ts` — the shell that spawns, since `packages/sh`'s own
twelve are still called in process — covering a here-document into a compound with and without a
preceding `read`, into the command itself, a pipeline into a compound, a redirection into a compound, and
an *empty* here-document, which is why the fix is a flag rather than a test on the byte count: an empty
here-document must give the child nothing rather than the terminal. Plus the two inheriting cases that
must keep inheriting — `cat; cat` sharing one descriptor (issue 0042) and `printf x | sh -c 'cat'`.

Verified failing without the fix: the first case answers empty where bash answers two lines.

Half of what [0061](../open/0061-sh-applets-return-all-their-output-at-once-so-a-large-stage-dies.md)
needs before `packages/sh` can spawn its own programs.
[0065](0065-a-spawned-programs-arguments-are-not-byte-exact.md) is the other half and is bigger than it
looked: the loss is not only in the wire format but in the *capability types* — `Pending<string>` forces a
JS string in the middle, and `TextDecoder`/`TextEncoder` are lossy in both directions. See its notes.
