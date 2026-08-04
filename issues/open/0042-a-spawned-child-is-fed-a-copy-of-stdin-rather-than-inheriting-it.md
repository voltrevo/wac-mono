# 0042 — a spawned child is fed a copy of standard input rather than inheriting it

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
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
