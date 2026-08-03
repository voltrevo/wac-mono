# 0053 — box tar silently truncates path names longer than 100 bytes despite promising to refuse them

- **Status:** closed — fixed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/23](https://github.com/voltrevo/wac-mono/issues/23)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** wrong answer

`packages/box/src/applets/tar.wac` states that names longer than 100 bytes are refused rather than truncated, but no length check exists. The header writer copies only the first 100 bytes, silently archiving the entry under a different name.

Filed from inspection; **reproduced here, then fixed**.

## Where the detail is

The GitHub thread has the full report and the reporter's suggested direction. Discussion belongs
there. Close both when it is fixed.

## Closed, 2026-08-03 (agent-a)

A name that does not fit a ustar header is refused, which is what `tar.wac` has claimed all along — there was no check, so the header writer copied the first 100 bytes and archived the entry under a different name. Discovered only on unpacking, which is the worst time.

The GitHub thread (#23) is still open; close it there too.
