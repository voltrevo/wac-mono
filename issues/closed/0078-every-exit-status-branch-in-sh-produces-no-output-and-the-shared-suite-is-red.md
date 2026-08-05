# 0078 — every exit-status branch in `sh` produces no output, and the shared suite is red

- **Status:** closed — fixed by `311e426`, by someone else, while this was being written
- **Reported by:** agent-b
- **Date:** 2026-08-05
- **Kind:** bug
- **Symptom:** wrong answer

`packages/sh/test/differential.test.ts` fails on **215 of 751** scripts. In every one of the 215,
our output is the empty string where bash produces something, and in every one the script branches
on an exit status.

This is on `origin/master` — measured in a clean worktree at `40bfcf8`, not only in a working tree —
so `deno task test` is red for whoever runs it next. That is why this is filed rather than fixed:
`harness/appRun.ts` and the sh differential are somebody's work in flight right now.

## Reproduction

```
deno test --allow-read --allow-write --allow-run --allow-net --allow-env \
    packages/sh/test/differential.test.ts
```

Any of the 215, e.g.:

| script | bash | ours |
| --- | --- | --- |
| `true && echo yes` | `yes\n`, exit 0 | `""`, exit 0 |
| `test a = a && echo same` | `same\n`, exit 0 | `""`, exit 0 |
| `false; echo $?` | `1\n`, exit 0 | `""`, exit 0 |
| `if true; then echo yes; fi` | `yes\n`, exit 0 | `""`, exit 0 |
| `while false; do echo never; done; echo done` | `done\n`, exit 0 | `""`, exit 0 |
| `echo aaa \| grep b; echo $?` | `1\n`, exit 0 | `""`, exit 0 |

The exit status the runner reports is 0 and matches bash. Only the output is missing.

## What the 215 have in common

Every failing script uses a construct that reads a command's exit status — `&&`, `||`, `$?`, `if`,
`while` or `until`. Splitting them:

| | count |
| --- | --- |
| contain `&&`, `\|\|` or `$?` | 93 |
| the rest, all `if` / `while` / `until` | 122 |

And the output is empty in **all** 215 — not truncated, not partial. `grep` for a non-empty `ours:`
in the failure report returns nothing. A script whose first command writes before any branching
(`echo aaa | grep b; echo $?`) still produces nothing at all, so whatever fails takes the earlier
output with it rather than only the branch.

That combination — output discarded entirely, exit status still correct — points at the output
capture in the in-process runner rather than at the shell's status handling. A shell that computed
`$?` wrongly would take the wrong branch and print the *other* string, not nothing.

## Notes

Arrived with the work merged in around `40bfcf8`: `e21f134` (run an application in this process
instead of spawning it), `3ca1d75` (the 604 differential cases run in this process), `64c5ad2`
(revert of the warm `buildApp`). The case count in the test is 751 now against the 604 named in that
commit, so the suite grew at the same time; whether that matters is for whoever picks this up.

Not a stale wac compiler. That was the first hypothesis, since a stale one makes other agents'
packages look broken — the count is identical at 21 commits behind and freshly pulled.

Probably related to [0076](0076-an-app-worker-runs-main-once-so-a-test-pays-a-fresh-one-per-case.md),
which is about the same worker path, though that one is a performance report and this is a wrong
answer.

## Resolution

Fixed by `311e426` — *platform: a zero-length write is a no-op, not the end of a stream* — which
landed in `origin/master` between this being measured and being committed. The differential passes
at `0f8f79a`: 751 of 751.

The diagnosis above was right about where to look and for the right reason. A zero-length write was
taken as end-of-stream, so the first one closed the capture and everything already written went with
it — which is why the output was empty rather than partial, and why the exit status was unaffected.
What made every failing script a branching one is that the branch constructs are what emit a
zero-length write.

Kept as a record because the reasoning is reusable: output discarded *entirely* while the exit status
stays correct is a stream-lifetime bug, not a logic bug. A shell computing `$?` wrongly would print
the other branch's string, not nothing.

### The mechanism, and how not to look for it (agent-a, 2026-08-05)

Verified independently at merge `647bec7`: all 751 scripts pass, run alone. Two of us closed this file in
the same minute, which is why the record has two voices — the reporter's reasoning above, and the
mechanism below.

Recording the shape, because it is a good one: `ByteQueue` uses an empty array as its **end** sentinel, so
handing a zero-length write to a *waiting* reader ends the stream from the reader's side and silently
discards everything after it. `sh`'s `true` builtin returns `Output.ok(u8[0]())` — zero bytes — which is
why every one of the 215 failing scripts branched on an exit status, and why `echo hi` was fine.

It needed three things to become reachable, none of them wrong on its own: `sh` writing its builtins'
output through a queue (0061), a parent draining that queue *while* the program runs rather than after it
exits (`harness: drain a child's output while it runs`), and a program that writes nothing. Before the
drain change the reader was never waiting, so an empty write went into the buffer where it was harmless.

I spent twenty minutes bisecting this from the other end — ruling out the worker count, then `appRunner`
in general, then the `env` option — and would have got there eventually. Checking whether somebody else
had already pushed a fix would have taken one `git fetch`. On a shared tree with three agents and a red
master, that is the first move rather than the last.

