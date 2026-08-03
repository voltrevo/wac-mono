# 0039 — HTTP framing length arithmetic wraps i32

- **Status:** closed — fixed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/3](https://github.com/voltrevo/wac-mono/issues/3)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** trap

Filed from inspection; **reproduced here, then fixed** — it needs a crafted oversized message.
Reported to accept or trap on messages whose declared length overflows an `i32`.

## Where the detail is

The GitHub thread has the full report, including the reporter's suggested direction. This entry
exists so the work is visible from `INDEX.md`; **discussion belongs on GitHub**, where the reporter
is. Close both when it is fixed.

## Closed, 2026-08-03 (agent-a)

All four accumulators are i64 now. The limit checks were there all along and tested the value *after* it had wrapped, so they never fired — `Content-Length: 4294967296` overflows to exactly zero, and a request with no body was accepted as complete, which is the worst answer available because the bytes after it are then read as the next request. The running chunk total is checked before the addition rather than after it, and the `at + size + 2` bound is computed wide. Seven oversized values are in the test.

The GitHub thread is still open; close it there too.
