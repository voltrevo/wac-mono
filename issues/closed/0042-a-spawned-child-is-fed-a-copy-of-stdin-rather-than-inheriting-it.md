# 0042 — a spawned child is fed a copy of standard input rather than inheriting it

- **Status:** closed
- **Claimed by:** agent-a
- **Reported by:** agent-a
- **Date:** 2026-08-04
- **Kind:** missing feature
- **Symptom:** wrong answer

Now that the shell reads its own standard input (issue 0032), one difference from bash is visible:

```sh
printf 'once\n' | ./wacsh -c 'cat; cat'    # once, twice
printf 'once\n' | bash    -c 'cat; cat'    # once
```

The shell hands each command *what is left* of its input, and nothing marks the input consumed
afterwards, because the shell cannot know how much a program read. The existing comment in
`runSimple` says exactly that, and it is right: guessing "it read everything" breaks
`echo hi; cat` and `seq 1 2; cat`, where a program that ignores its input must leave it for the next
one — both of which agree with bash today.

bash does not need to know. Both `cat`s share file descriptor 0, and the second finds it at the end.

## What would fix it

Let a spawned child *inherit* the parent's standard input instead of being fed a queue. `spawn` and
`spawnSelf` would take that as a flag, and the host would then leave the child's `readStdin` pointing
at the process's own input rather than at the parent-filled queue — the plumbing is one branch in each
of the three `startChild` functions, since a world with no `readStdin` option already falls back to the
real one.

The shell would ask for it in exactly one case: when the command's input is the shell's own unread
standard input, rather than a pipeline stage's output, a redirection or a here-document.

## Why it is worth more than the one divergence

It also removes a memory bug that is easy to miss. `restOfStdin` reads *all* of standard input on first
need, because `readStdin` promises everything — so `yes | sh -c 'head -1'` buffers without bound
instead of streaming, and a shell fed a large file holds the whole thing. An inherited descriptor
streams, and `head` closing it ends the producer, exactly as issue 0038 made pipelines do.

## Notes

`packages/sh/test/differential.test.ts` has the cases that agree, and says in its header which one
does not and why. Fixing this should turn `cat; cat` into one of them.

## Closed, 2026-08-04 (agent-a)

`spawn` and `spawnSelf` take `inheritIn`. When it is set the host leaves the child's `readStdin` and
`readStdinChunk` *out* of its world, and a world without them already falls back to the process's own
input — so handing the descriptor over is an omission rather than a mechanism, in all three hosts.

The shell asks for it in exactly one case, computed in `runSimple`: no pipeline stage's output, no
redirection, no here-document, this shell owns the process's input, and it has not already been read.
`dispatch` carries that as `mayInherit` rather than as bytes, and the routes that run *inside* the shell
ask for `sh.restOfStdin()` themselves — which reads the input at that moment. The two are exclusive and
which happens depends on what the name turns out to be, which is only known after the builtins and
functions have been ruled out.

    printf 'once\ntwice\n' | wacsh -c 'cat; cat'      once, twice   (was: twice over)
    printf 'kept\n'         | wacsh -c 'seq 1 2; cat'  1 2 kept      (unchanged: seq reads nothing)
    printf 'one\ntwo\n'     | wacsh -c 'read x; cat'   one left, two   (unchanged)
    yes | wacsh -c 'head -1'                          y, at once    (was: buffered without bound)

That last line is the other half of the issue and the reason this is worth more than one divergence:
feeding a child means having its bytes first, so an endless input was read for ever. An inherited
descriptor streams, and `head` closing it ends the producer.

**`read` needed its own call.** It walks `stdinBytes` and `stdinPos` directly — it must, since it takes
one line and leaves the rest — so it saw an empty buffer while a `cat` after it saw everything.
`ensureStdin` is the shared trigger, called by `restOfStdin` and by `read`.

A streaming pipeline stage deliberately does *not* inherit: `streamPipeline` sends to every stage
including the first, and a stage reading the real descriptor as well would race the shell for the same
bytes.

## Where the case lives, and why not in the differential suite

`cat; cat` is pinned in `packages/box/test/shell.test.ts`, not in `packages/sh`'s 539 scripts. That
binary is `packages/sh` alone, whose `cat` is one of the small wac implementations in `program.wac` — a
function call handed a byte array, with no way for the shell to know how much of it was read. The
divergence therefore remains for a shell whose commands are not real programs, and the differential
suite's header says so. `echo hi; cat` and `seq 1 2; cat` are in both, since they turn on a command
*not* reading rather than on who consumed what.
