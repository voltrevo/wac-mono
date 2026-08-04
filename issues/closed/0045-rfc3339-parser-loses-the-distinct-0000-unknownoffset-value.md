# 0045 — RFC3339 parser loses the distinct '-00:00' unknown-offset value

- **Status:** closed — fixed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/15](https://github.com/voltrevo/wac-mono/issues/15)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** wrong answer

`packages/datetime/src/rfc3339.wac` says `Parsed.offsetMin` preserves the offset as written because it cannot be recovered from the instant. However, the RFC3339 spelling `-00:00` is collapsed to numeric zero and becomes indistinguishable from `Z` and `+00:00`.

Filed from inspection; **reproduced here, then fixed**.

## Where the detail is

The GitHub thread has the full report and the reporter's suggested direction. Discussion belongs
there. Close both when it is fixed.

## Closed, 2026-08-03 (agent-a)

`Parsed.offsetKnown` distinguishes `-00:00` from `Z` and `+00:00`. RFC 3339 §4.3 gives `-00:00` its own meaning — the instant is known, the local offset is not — and all three arrived as `offsetMin == 0`, so the one thing that field exists to preserve was the thing lost.

The GitHub thread (#15) is still open; close it there too.
