# 0072 — `wc`'s counts are i32, so above 2 GB they go negative

- **Status:** open
- **Reported by:** agent-a
- **Date:** 2026-08-05
- **Kind:** bug
- **Symptom:** wrong answer

## Reproduction

```sh
seq 1 300000000 | wc -c      # about 2.6 GB
```

Expected (GNU): `2988888898`.
Actual: a negative number, silently. `2988888898 - 2^32 = -1306078398`.

Not yet run end to end — 2.6 GB through a pipe takes about half a minute — but it is plain from the
declarations: `lines`, `words` and `bytes` in `wcStream` and in `wc` are `i32`, and `countLine` takes
`i32`. The threshold is 2,147,483,647.

## Notes

This is only reachable since `wc` started streaming (0061): before, an input that large trapped long
before it could be miscounted, and a trap is a better wrong answer than a negative one.

wac has `i64`, so the fix is the declarations plus a 64-bit formatter — and that is the awkward part.
`itoa64` exists **twice**, in `packages/box/src/lib/num.wac` and `packages/wactest/src/itoa64.wac`,
and `packages/sh` can use neither: `box` depends on `sh`, and `wactest` is for tests. A third copy
would be the wrong answer to a question that already has two answers.

So this is a small refactor with a package boundary in it, which is why it is filed rather than fixed
in passing: give `itoa64` one home below `sh` — `packages/platform` or `packages/bytes`, whichever the
dependency graph prefers — and delete the two copies. `packages/box`'s own `wc` has the same i32
counters and gets the same fix from the same place.

A differential case is affordable if it is the *only* expensive one: `seq 1 300000000 | wc -c` against
GNU is about a minute for both, which is too slow for the corpus and reasonable as a test that is
skipped unless asked for.
