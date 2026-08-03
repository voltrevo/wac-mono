# 0039 — HTTP framing length arithmetic wraps i32

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/3](https://github.com/voltrevo/wac-mono/issues/3)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** trap

Filed from inspection; **not yet verified here** — it needs a crafted oversized message.
Reported to accept or trap on messages whose declared length overflows an `i32`.

## Where the detail is

The GitHub thread has the full report, including the reporter's suggested direction. This entry
exists so the work is visible from `INDEX.md`; **discussion belongs on GitHub**, where the reporter
is. Close both when it is fixed.
