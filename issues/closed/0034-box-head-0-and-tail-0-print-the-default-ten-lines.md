# 0034 — box head -0 and tail -0 print the default ten lines

- **Status:** closed — fixed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/8](https://github.com/voltrevo/wac-mono/issues/8)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** wrong answer

`Args.num` uses `0` for both "no numeric option" and "the user asked for zero", and both applets
read zero as their default of ten.

**Verified.** `printf 'a\nb\n' | box head -0` prints both lines; GNU prints nothing. Needs presence
kept separately from value — `bool hasNum` or an `Option<i32>`.

## Where the detail is

The GitHub thread has the full report, including the reporter's suggested direction. This entry
exists so the work is visible from `INDEX.md`; **discussion belongs on GitHub**, where the reporter
is. Close both when it is fixed.

## Closed, 2026-08-03 (agent-a)

`Args.hasNum` carries presence separately from value, and the eight applets that spelled their default as `num == 0` now ask. `head -0`, `head -n 0`, `tail -0`, `tail -n 0` all print nothing, checked against the real ones.

The GitHub thread is still open; close it there too.
