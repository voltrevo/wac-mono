# 0040 — bignum shifts by INT32_MIN recurse until stack overflow

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/4](https://github.com/voltrevo/wac-mono/issues/4)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** trap

Filed from inspection; **not yet verified here**. Reported to recurse on a negated shift count,
where negating `i32::MIN` leaves it negative.

## Where the detail is

The GitHub thread has the full report, including the reporter's suggested direction. This entry
exists so the work is visible from `INDEX.md`; **discussion belongs on GitHub**, where the reporter
is. Close both when it is fixed.
