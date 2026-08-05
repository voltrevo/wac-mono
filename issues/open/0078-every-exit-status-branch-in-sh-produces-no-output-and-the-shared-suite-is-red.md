# 0078 — every exit-status branch in `sh` produces no output, and the shared suite is red

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
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
