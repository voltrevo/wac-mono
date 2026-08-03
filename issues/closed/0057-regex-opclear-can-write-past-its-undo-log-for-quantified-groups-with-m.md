# 0057 — regex OP_CLEAR can write past its undo log for quantified groups with many captures

- **Status:** closed — fixed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/27](https://github.com/voltrevo/wac-mono/issues/27)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** trap

`packages/regex/src/program.wac` attempts to reserve undo-log space before clearing every capture inside a quantified body, but its capacity check tests the unchanged `undoLen` once per slot. It never includes the number of slots about to be appended.

Filed from inspection; **reproduced here, then fixed**.

## Where the detail is

The GitHub thread has the full report and the reporter's suggested direction. Discussion belongs
there. Close both when it is fixed.

## Closed, 2026-08-03 (agent-a)

The undo log is reserved for the whole span at once. The check compared the *unchanged* length against the cap once per slot, which only ever catches a log that is already full — so a quantified group with enough captures wrote past the arrays and trapped, where the point of the check is to return BUDGET. The test drives it through a new `execBudget` probe, and reverting the fix fails it.

The GitHub thread (#27) is still open; close it there too.
