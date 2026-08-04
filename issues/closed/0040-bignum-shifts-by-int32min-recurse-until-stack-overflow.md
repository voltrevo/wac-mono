# 0040 — bignum shifts by INT32_MIN recurse until stack overflow

- **Status:** closed — fixed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/4](https://github.com/voltrevo/wac-mono/issues/4)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** trap

Filed from inspection; **reproduced here, then fixed**. Reported to recurse on a negated shift count,
where negating `i32::MIN` leaves it negative.

## Where the detail is

The GitHub thread has the full report, including the reporter's suggested direction. This entry
exists so the work is visible from `INDEX.md`; **discussion belongs on GitHub**, where the reporter
is. Close both when it is fixed.

## Closed, 2026-08-03 (agent-a)

`-i32::MIN` is still negative, so `shl` handed it to `shr`, which handed it back. Shifting right by 2^31 takes everything out of any value that fits in memory, which has a correct answer — zero, or -1 for a negative value — and that is what `shl(a, MIN)` returns. The other direction has no representable answer and now refuses immediately. My first attempt routed it through the largest legal left shift, whose allocation *succeeds* and then zeroes 256MB: a stack overflow in one second became a hang of minutes, which I only found by measuring it.

The GitHub thread is still open; close it there too.
