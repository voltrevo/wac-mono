# 0054 — Buf.reserveFor can loop forever when capacity doubling overflows

- **Status:** closed — fixed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/24](https://github.com/voltrevo/wac-mono/issues/24)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** trap

`packages/bytes/src/buf.wac` rounds capacity upward by repeatedly doubling an `i32`. A sufficiently large positive reservation causes that value to wrap through a negative number to zero, after which the loop never makes progress.

Filed from inspection; **reproduced here, then fixed**.

## Where the detail is

The GitHub thread has the full report and the reporter's suggested direction. Discussion belongs
there. Close both when it is fixed.

## Closed, 2026-08-03 (agent-a)

The growth arithmetic is i64. In i32 both halves wrapped: `len + extra` past the ceiling went negative and the buffer silently did not grow, and a wrapped capacity made the doubling loop run for ever. A hang and a silent under-allocation from two lines.

The GitHub thread (#24) is still open; close it there too.
