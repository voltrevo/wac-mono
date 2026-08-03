# 0059 — JSON stringify emits invalid tokens for NaN and infinities in hand-built trees

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/29](https://github.com/voltrevo/wac-mono/issues/29)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** wrong answer

`JsonValue.numberOf(f64)` allows any floating-point value, and the serializer passes it to the general float formatter. For NaN and infinities, that formatter emits JavaScript number spellings such as `NaN` and `Infinity`, which are not valid JSON.

Filed from inspection; **not yet reproduced here**.

## Where the detail is

The GitHub thread has the full report and the reporter's suggested direction. Discussion belongs
there. Close both when it is fixed.
