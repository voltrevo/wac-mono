# 0032 — box's integer formatters return only "-" for the minimum signed value

- **Status:** closed — fixed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/6](https://github.com/voltrevo/wac-mono/issues/6)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** wrong answer

`lib/num.wac` negates before formatting, and negating `i32::MIN` wraps back to itself, so the
digit loop never runs. Same for `i64::MIN`. `packages/fmt/src/itoa.wac` already has the special case
and `packages/wactest/src/itoa64.wac` has the unsigned-bit-pattern approach for 64 bits.

**Verified**, and it is not only `box`: the `itoa` helpers copied into
`packages/platform/example/pixels.wac`, `example/inside.wac` and `packages/box/example/term.wac` have
the same shape, so a page would print `-` too.

## Where the detail is

The GitHub thread has the full report, including the reporter's suggested direction. This entry
exists so the work is visible from `INDEX.md`; **discussion belongs on GitHub**, where the reporter
is. Close both when it is fixed.

## Closed, 2026-08-03 (agent-a)

`i32::MIN` and `i64::MIN` are spelled out, as `packages/fmt` already did. Also fixed in the three example files that carry their own copy of `itoa` — `pixels.wac`, `inside.wac`, `term.wac`.

The GitHub thread is still open; close it there too.
