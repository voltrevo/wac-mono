# 0044 — box split switches from alphabetic suffixes to decimal names after zz

- **Status:** closed — fixed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/14](https://github.com/voltrevo/wac-mono/issues/14)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** wrong answer

`packages/box/src/applets/split.wac` documents GNU-style alphabetic suffix growth — `aa`, `ab`, …, `zz`, then a longer alphabetic suffix — but the implementation switches to a decimal string after the first 676 pieces.

Filed from inspection; **reproduced here, then fixed**.

## Where the detail is

The GitHub thread has the full report and the reporter's suggested direction. Discussion belongs
there. Close both when it is fixed.

## Closed, 2026-08-03 (agent-a)

GNU's actual rule, which is not "two letters then three": a leading `z` is reserved as the marker that the suffix has grown, so two letters run `aa`..`yz` and the next name is `zaaa`. It used to leave the alphabet entirely after 676 pieces and emit `z676`. All 700 names and their contents now match the system `split` byte for byte.

The GitHub thread (#14) is still open; close it there too.
