# 0046 — Buf.pushCodepoint emits malformed UTF-8 for non-scalar values

- **Status:** closed — fixed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/16](https://github.com/voltrevo/wac-mono/issues/16)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** wrong answer

`packages/bytes/src/buf.wac` documents `pushCodepoint` as appending a Unicode scalar as UTF-8, but it does not validate that its `i32` argument is a scalar value.

Filed from inspection; **reproduced here, then fixed**.

## Where the detail is

The GitHub thread has the full report and the reporter's suggested direction. Discussion belongs
there. Close both when it is fixed.

## Closed, 2026-08-03 (agent-a)

Anything that is not a Unicode scalar — negative, above U+10FFFF, or a surrogate — becomes U+FFFD, and the method says so. It used to encode them: a surrogate came out as the CESU-8 form strict decoders reject. Tested at every boundary, with the values either side of each hole.

The GitHub thread (#16) is still open; close it there too.
