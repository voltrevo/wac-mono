# 0060 — JSON stringify can emit malformed UTF-8 from a hand-built Str value

- **Status:** closed — fixed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/30](https://github.com/voltrevo/wac-mono/issues/30)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** wrong answer

`JsonValue.Str` stores raw `u8[]`, and `writeString` copies every byte at or above ASCII space directly into the output. A hand-built string containing malformed UTF-8 therefore produces bytes that are not valid RFC 8259 JSON.

Filed from inspection; **reproduced here, then fixed**.

## Where the detail is

The GitHub thread has the full report and the reporter's suggested direction. Discussion belongs
there. Close both when it is fixed.

## Closed, 2026-08-03 (agent-a)

Ill-formed bytes in a hand-built `Str` become U+FFFD. Every byte at or above space used to be copied through, so `Str(u8[](0xFF))` produced output that is not JSON. Overlong encodings, encoded surrogates and truncated sequences are all rejected by the same walk, with the boundary cases tested.

The GitHub thread (#30) is still open; close it there too.
