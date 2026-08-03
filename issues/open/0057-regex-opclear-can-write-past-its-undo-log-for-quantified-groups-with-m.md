# 0057 — regex OP_CLEAR can write past its undo log for quantified groups with many captures

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/27](https://github.com/voltrevo/wac-mono/issues/27)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** trap

`packages/regex/src/program.wac` attempts to reserve undo-log space before clearing every capture inside a quantified body, but its capacity check tests the unchanged `undoLen` once per slot. It never includes the number of slots about to be appended.

Filed from inspection; **not yet reproduced here**.

## Where the detail is

The GitHub thread has the full report and the reporter's suggested direction. Discussion belongs
there. Close both when it is fixed.
