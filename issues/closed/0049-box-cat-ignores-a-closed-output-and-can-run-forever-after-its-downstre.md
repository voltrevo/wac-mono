# 0049 — box cat ignores a closed output and can run forever after its downstream consumer exits

- **Status:** closed — fixed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/19](https://github.com/voltrevo/wac-mono/issues/19)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** trap

`Cli.write` returns `false` when standard output is closed, specifically so a producer can stop. `box cat` discards that result and continues reading until input EOF.

Filed from inspection; **reproduced here, then fixed**.

## Where the detail is

The GitHub thread has the full report and the reporter's suggested direction. Discussion belongs
there. Close both when it is fixed.

## Closed, 2026-08-03 (agent-a)

`cat` stops when `write` answers false. It discarded that answer and kept reading, so `cat` of an endless source ran for ever after whatever was reading it had exited. Success, as it is for any filter, and the same way `yes` ends.

The GitHub thread (#19) is still open; close it there too.
