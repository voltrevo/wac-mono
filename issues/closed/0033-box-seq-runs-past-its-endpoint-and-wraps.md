# 0033 — box seq runs past its endpoint and wraps

- **Status:** closed — fixed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/7](https://github.com/voltrevo/wac-mono/issues/7)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** wrong answer

**Verified.** `box seq 2147483647 2147483647` prints the endpoint and then keeps going, wrapping
to negative — the loop compares `i <= to` after `i` has already overflowed. Combined with #32 it
prints a `-` line mid-stream.

## Where the detail is

The GitHub thread has the full report, including the reporter's suggested direction. This entry
exists so the work is visible from `INDEX.md`; **discussion belongs on GitHub**, where the reporter
is. Close both when it is fixed.

## Closed, 2026-08-03 (agent-a)

Counted rather than compared: the number of values is computed in `i64` before printing any, so an accumulator that wraps cannot re-satisfy `i <= last`. `--` also ends the options now, as GNU's does. Both ends of the range are in the differential test.

The GitHub thread is still open; close it there too.
