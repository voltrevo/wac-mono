# 0043 — box find and du silently truncate valid directory trees deeper than 32 levels

- **Status:** closed — fixed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/13](https://github.com/voltrevo/wac-mono/issues/13)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** wrong answer

`box find` and `box du` use a hard-coded recursion depth of 32 as a substitute for symlink-cycle detection. A valid directory tree deeper than that is silently truncated:

Filed from inspection; **reproduced here, then fixed**.

## Where the detail is

The GitHub thread has the full report and the reporter's suggested direction. Discussion belongs
there. Close both when it is fixed.

## Closed, 2026-08-03 (agent-a)

The depth bound is 64 and reaching it is an error: `find` and `du` say which directory they stopped at and exit 1. They used to `return` silently, so `find` printed an incomplete listing and exited 0 and `du` reported a total that was short — a wrong number that looks like an answer. The bound stays because `stat` cannot see a symlink; the real fix is link-aware metadata (0055).

The GitHub thread (#13) is still open; close it there too.
