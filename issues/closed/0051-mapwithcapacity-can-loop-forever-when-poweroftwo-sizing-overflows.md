# 0051 — Map.withCapacity can loop forever when power-of-two sizing overflows

- **Status:** closed — fixed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/21](https://github.com/voltrevo/wac-mono/issues/21)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** trap

`packages/std/src/map.wac` computes its requested slot count and rounds it up to a power of two using wrapping `i32` arithmetic. For a sufficiently large positive capacity hint, the doubling loop overflows to a negative value and then to zero, after which its condition remains true forever.

Filed from inspection; **reproduced here, then fixed**.

## Where the detail is

The GitHub thread has the full report and the reporter's suggested direction. Discussion belongs
there. Close both when it is fixed.

## Closed, 2026-08-03 (agent-a)

The power-of-two sizing is i64 and clamped. Both lines wrapped in i32: a large capacity made `want` negative, and once the doubling passed the ceiling `size` went negative and the loop never ended.

The GitHub thread (#21) is still open; close it there too.
