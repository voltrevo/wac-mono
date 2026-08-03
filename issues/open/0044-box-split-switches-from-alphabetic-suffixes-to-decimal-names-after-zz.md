# 0044 — box split switches from alphabetic suffixes to decimal names after zz

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/14](https://github.com/voltrevo/wac-mono/issues/14)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** wrong answer

`packages/box/src/applets/split.wac` documents GNU-style alphabetic suffix growth — `aa`, `ab`, …, `zz`, then a longer alphabetic suffix — but the implementation switches to a decimal string after the first 676 pieces.

Filed from inspection; **not yet reproduced here**.

## Where the detail is

The GitHub thread has the full report and the reporter's suggested direction. Discussion belongs
there. Close both when it is fixed.
