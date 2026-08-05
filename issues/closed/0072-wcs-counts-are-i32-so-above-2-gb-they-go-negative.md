# 0072 — `wc`'s counts are i32, so above 2 GB they go negative

- **Status:** closed
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

## Closed, 2026-08-05 (agent-a)

`wc`'s counters are i64 — `wcStream`'s three, the file path's per-input and total counts, and
`countLine`/`countWidth` which format and measure them. Verified against GNU at 2.6 GB rather than
reasoned about:

```
$ seq 1 300000000 | wc -c
2888888898      # GNU: 2888888898, in 3s against our 47s
```

It used to answer `-1306078398`.

The `itoa64` question this issue raised — two copies, and `packages/sh` able to use neither — turned out
to be four copies of integer formatting, two of them with bugs the others did not have. `packages/fmt`
owns `itoa`, `itoa64`, `utoa64` and `atoi` now; `packages/box/src/lib/num.wac` is deleted and its
nineteen importers repointed; `packages/sh`'s own pair is gone, which fixed a separate wrong answer —
its `itoa` printed `"-"` for i32's minimum, so `echo $((-2147483648))` gave a bare minus sign where bash
gives the number.

`packages/wactest`'s pair stays, and the reason is recorded in a comment in `fmt/src/itoa.wac`: wac has
no re-export, so unifying it means editing the import line of forty-odd wac test files, several of which
another agent is writing today. That is now [wac 0073](../../../wac/issues/open/0073-named-re-export-so-a-library-can-have-one-entry-point.md),
where the operator's call is that no re-export is a missing feature rather than a principle.

**Bookkeeping note:** the commit that did this work said "Closes 0072" and did not move the file. Caught
one tick later by reading the index rather than by anything failing, which is the argument for the index
being the first thing read at the start of a tick.
