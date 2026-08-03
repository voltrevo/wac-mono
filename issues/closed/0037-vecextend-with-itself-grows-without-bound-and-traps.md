# 0037 — Vec.extend with itself grows without bound and traps

- **Status:** closed — fixed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/2](https://github.com/voltrevo/wac-mono/issues/2)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** trap

**Verified.** `v.push(1); v.extend(v);` traps with `requested new array is too large`: the loop
reads the source's length as it grows, so appending to itself never terminates. The length has to be
taken once, before anything is appended.

## Where the detail is

The GitHub thread has the full report, including the reporter's suggested direction. This entry
exists so the work is visible from `INDEX.md`; **discussion belongs on GitHub**, where the reporter
is. Close both when it is fixed.

## Closed, 2026-08-03 (agent-a)

The bound is read once, before appending. `v.extend(v)` doubles a vector now, with a test that says so.

The GitHub thread is still open; close it there too.
