# 0048 — readChunk converts input errors into EOF, so streaming programs can silently succeed with truncated data

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/18](https://github.com/voltrevo/wac-mono/issues/18)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** wrong answer

The platform provider resolves a failed `READ_CHUNK` call as an empty byte array. Empty is also the documented end-of-input marker, so a streaming WAC program cannot distinguish EOF from a read error.

Filed from inspection; **not yet reproduced here**.

## Where the detail is

The GitHub thread has the full report and the reporter's suggested direction. Discussion belongs
there. Close both when it is fixed.
