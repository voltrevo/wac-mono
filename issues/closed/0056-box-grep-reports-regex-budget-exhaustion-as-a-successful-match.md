# 0056 — box grep reports regex budget exhaustion as a successful match

- **Status:** closed — fixed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/26](https://github.com/voltrevo/wac-mono/issues/26)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** wrong answer

The regex engine distinguishes `NO_MATCH` (`-1`) from `BUDGET` (`-2`), but `box grep` checks only whether the result differs from `NO_MATCH`. A pattern that exhausts its backtracking budget is therefore treated as a match.

Filed from inspection; **reproduced here, then fixed**.

## Where the detail is

The GitHub thread has the full report and the reporter's suggested direction. Discussion belongs
there. Close both when it is fixed.

## Closed, 2026-08-03 (agent-a)

`grep` distinguishes three answers now. `BUDGET` means the engine gave up backtracking on that line, and testing `!= NO_MATCH()` counted it as a match — so a pathological pattern reported hits it never found and `-c` counted them. Exit 2, because neither "matched" nor "did not match" is known.

The GitHub thread (#26) is still open; close it there too.
