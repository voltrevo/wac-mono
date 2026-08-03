# 0053 — box tar silently truncates path names longer than 100 bytes despite promising to refuse them

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/23](https://github.com/voltrevo/wac-mono/issues/23)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** wrong answer

`packages/box/src/applets/tar.wac` states that names longer than 100 bytes are refused rather than truncated, but no length check exists. The header writer copies only the first 100 bytes, silently archiving the entry under a different name.

Filed from inspection; **not yet reproduced here**.

## Where the detail is

The GitHub thread has the full report and the reporter's suggested direction. Discussion belongs
there. Close both when it is fixed.
