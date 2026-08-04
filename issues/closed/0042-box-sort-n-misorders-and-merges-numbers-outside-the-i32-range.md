# 0042 — box sort -n misorders and merges numbers outside the i32 range

- **Status:** closed — fixed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/12](https://github.com/voltrevo/wac-mono/issues/12)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** wrong answer

`packages/box/src/lib/lines.wac` parses the leading number for `sort -n` into an `i32` using unchecked arithmetic. Decimal integers outside the signed 32-bit range wrap, so numeric ordering becomes wrong and `sort -nu` can treat distinct values as duplicates.

**Verified, and worse than the title suggests.** `sort -n` over `4294967296 1 2147483648 -1` answers `2147483648 -1 4294967296 1`, and `sort -nu` over `4294967296` and `0` prints one line — a distinct value silently dropped. My own `leadingNumber`, added the same day, parses into an i32.

## Where the detail is

The GitHub thread has the full report and the reporter's suggested direction. Discussion belongs
there. Close both when it is fixed.

## Closed, 2026-08-03 (agent-a)

The numeric key is i64 and saturates instead of wrapping. It was i32 — my own code, added the same day — so `sort -n` over `4294967296 1 2147483648 -1` answered `2147483648 -1 4294967296 1`, and `-nu` merged `4294967296` with `0` and dropped a distinct line. Both cases are differential against GNU now. Values wider than i64 saturate rather than wrap, which keeps the order monotonic; comparing those exactly needs arbitrary precision and is a different change.

The GitHub thread (#12) is still open; close it there too.
