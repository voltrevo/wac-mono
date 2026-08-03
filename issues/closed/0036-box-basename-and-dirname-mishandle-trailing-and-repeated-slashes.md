# 0036 — box basename and dirname mishandle trailing and repeated slashes

- **Status:** closed — fixed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/10](https://github.com/voltrevo/wac-mono/issues/10)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** wrong answer

**Verified.** `box basename a/b/` is empty where GNU says `b`, and `box dirname a/b/` says `a/b`
where GNU says `a`. Trailing slashes have to be stripped before the last separator is found.

## Where the detail is

The GitHub thread has the full report, including the reporter's suggested direction. This entry
exists so the work is visible from `INDEX.md`; **discussion belongs on GitHub**, where the reporter
is. Close both when it is fixed.

## Closed, 2026-08-03 (agent-a)

Trailing slashes are stripped first, in a shared `lib/path.wac` so the two applets cannot drift. All nine paths × both applets agree with GNU, in the differential test.

The GitHub thread is still open; close it there too.
