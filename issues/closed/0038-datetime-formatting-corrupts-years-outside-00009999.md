# 0038 — datetime formatting corrupts years outside 0000..9999

- **Status:** closed — fixed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/1](https://github.com/voltrevo/wac-mono/issues/1)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** wrong answer

Filed from inspection; **reproduced here, then fixed**. Reported to affect the formatter's fixed
four-digit year assumption.

## Where the detail is

The GitHub thread has the full report, including the reporter's suggested direction. This entry
exists so the work is visible from `INDEX.md`; **discussion belongs on GitHub**, where the reporter
is. Close both when it is fixed.

## Closed, 2026-08-03 (agent-a)

A year outside 0000..9999 is written the way `Date.toISOString` writes it — a sign and six digits, `+010000`, `-000001`. It was `pad(year, 4)`, which takes the year modulo ten thousand, so year 10000 printed `0000`: not a near miss but a different millennium. The existing test's random spread covers about 1963 to 1976 and could never have caught it; the six instants at the edges of `Date`'s range are in it now.

The GitHub thread is still open; close it there too.
