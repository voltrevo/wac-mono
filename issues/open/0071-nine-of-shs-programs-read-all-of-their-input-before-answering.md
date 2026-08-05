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

Nine call `fed.rest()` in `packages/sh/src/program.wac`: `cat`, `sort`, `uniq`, `tr`, `grep`, `nl`,
`rev`, `cut`, `fold`. `head`, `tail` and `wc` have streaming paths for "standard input and nothing
else", and `wc`'s is the model — the file-operand path stays as it is, since a file is bounded by the
file, and the streaming path is taken when there are no operands.

Three groups, and they want different answers:

1. **Byte- or line-at-a-time filters**: `cat`, `tr`, `rev`, `nl`, `grep`, `cut`, `fold`. Each is a
   `Lines`/chunk loop and each is worth doing — `cat` most of all, since a pipeline stage that only
   copies should be free.
2. **Adjacent-line state**: `uniq`. Streams with one held line.
3. **Genuinely needs all of it**: `sort`. Holding the input is the algorithm. The honest answer is a
   bounded one — an external merge would be a project, so until then it should report that the input
   is larger than it can sort rather than trapping with the runtime's words.

Do them one at a time with a differential case each, and check the case fails first: a filter that
streams and a filter that buffers are indistinguishable on small input, which is why the corpus never
saw this.
