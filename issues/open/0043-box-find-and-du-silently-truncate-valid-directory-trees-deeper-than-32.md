# 0043 — box find and du silently truncate valid directory trees deeper than 32 levels

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/13](https://github.com/voltrevo/wac-mono/issues/13)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** wrong answer

`box find` and `box du` use a hard-coded recursion depth of 32 as a substitute for symlink-cycle detection. A valid directory tree deeper than that is silently truncated:

Filed from inspection; **not yet reproduced here**.

## Where the detail is

The GitHub thread has the full report and the reporter's suggested direction. Discussion belongs
there. Close both when it is fixed.
