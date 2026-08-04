# 0031 — box's shared argument parser eats a numeric operand after any -n flag

- **Status:** closed — fixed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/5](https://github.com/voltrevo/wac-mono/issues/5)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** wrong answer

`lib/args.wac` treats `-n <digits>` as a numeric option value for *every* applet, so an applet
where `-n` is a boolean loses its operand. There is a second bug beside it: the sizing pass counts
the detached value as positional and the fill pass consumes it, so `rest` keeps a phantom `""`.

**Verified.** `box grep -n 123 input` prints nothing where GNU prints `1:123`, and `box sort -n 123`
— with `123` as a filename — fails with `sort: : Empty path is not allowed`, which is the phantom
entry reaching `openStream`. Both silent-wrong-answer shaped.

Root of #33 as well, and reachable in a new way since `sort` gained `-n`.

## Where the detail is

The GitHub thread has the full report, including the reporter's suggested direction. This entry
exists so the work is visible from `INDEX.md`; **discussion belongs on GitHub**, where the reporter
is. Close both when it is fixed.

## Closed, 2026-08-03 (agent-a)

One pass over a scratch array, so the sizing and filling cannot disagree — the phantom `""` is gone — and `-n` takes a value only for `head` and `tail`, which is where GNU has one. `box grep -n 123 f` and `box sort -n f` now match GNU exactly, and both are in the differential test.

The GitHub thread is still open; close it there too.
