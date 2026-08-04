# 0035 — box urlencode leaves reserved component bytes unescaped

- **Status:** closed — fixed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/9](https://github.com/voltrevo/wac-mono/issues/9)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** wrong answer

**Verified.** `printf 'a/b\n' | box urlencode` answers `a/b`; percent-encoding a *component*
should give `a%2Fb`. Anything not unreserved needs escaping, or the output cannot be pasted into a
URL, which is the only reason the applet exists.

## Where the detail is

The GitHub thread has the full report, including the reporter's suggested direction. This entry
exists so the work is visible from `INDEX.md`; **discussion belongs on GitHub**, where the reporter
is. Close both when it is fixed.

## Closed, 2026-08-03 (agent-a)

`SET_COMPONENT` rather than `SET_PATH`, which also deleted the hand-rolled `%`-escaping pre-pass — the component set escapes `%` itself. Checked against `urllib.parse.quote(safe="")` on four cases including `%20` → `%2520`.

The GitHub thread is still open; close it there too.
