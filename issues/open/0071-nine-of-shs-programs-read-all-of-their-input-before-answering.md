# 0071 — nine of `sh`'s programs read all of their input before answering

- **Status:** open
- **Reported by:** agent-a
- **Date:** 2026-08-05
- **Kind:** bug
- **Symptom:** trap

## Reproduction

```sh
seq 1 200000000 | sort | head -1     # 1.9 GB through `sort`
seq 1 200000000 | cat | wc -c        # …or through `cat`, which needs to hold nothing at all
```

Actual: `wac: requested new array is too large` on the stage that holds it, and 126 from the
pipeline. bash answers both.

Expected: the programs that can answer without holding the input should not hold it. `sort` genuinely
must — that is what sorting is — and should say so rather than trap.

## Notes

Six call `fed.rest()` in `packages/sh/src/program.wac`: `sort`, `uniq`, `tr`, `grep`, `nl` and `rev`.
`head`, `tail`, `wc` and `cat` have streaming paths, and `cat`'s is the model — one `Feed` per input,
whether it came from a file or from standard input, so there is one implementation and the file path is
bounded by the file rather than by the sum of them.

(This issue first said "nine", and listed `cut` and `fold`. Neither exists in this shell — they are
`packages/box` applets. `cat` is done; the count is six.)

Three groups, and they want different answers:

1. **Line-at-a-time filters**: `tr`, `rev`, `nl`, `grep`. Each is a `Lines` loop over a `Feed`.
2. **Adjacent-line state**: `uniq`. Streams with one held line.
3. **Genuinely needs all of it**: `sort`. Holding the input is the algorithm. The honest answer is a
   bounded one — an external merge would be a project, so until then it should report that the input
   is larger than it can sort rather than trapping with the runtime's words. Note that it is *also* an
   insertion sort: 100,000 lines takes four seconds where GNU takes none, so whoever takes this should
   fix the algorithm at the same time as the shape.

One more thing that comes with streaming, learned from `cat`: **flush the output sink before writing to
the error one.** A `Sink` holds 64 KiB, so a complaint written straight to standard error overtakes the
output that came before it, and `cat missing f` printed them in the wrong order. `complain()` in
`program.wac` is the helper; every one of these six needs it as it starts reporting per-input failures
in place.

Do them one at a time with a differential case each, and check the case fails first: a filter that
streams and a filter that buffers are indistinguishable on small input, which is why the corpus never
saw this.
