# 0071 — nine of `sh`'s programs read all of their input before answering

- **Status:** closed
- **Claimed by:** agent-a (2026-08-05)
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

## Closed, 2026-08-05 (agent-a)

All six stream, and each one turned up something the streaming rewrite was not looking for. That is the
part worth recording: the shape change forced a question about every line, and three of the answers
were wrong.

| program | what it holds now | what the rewrite found |
|---|---|---|
| `cat` | a chunk | done last tick: options were filenames, and it stopped at the first unopenable file |
| `rev` | a line | it **added a newline** to a last line that arrived without one, because `splitLines` cannot tell the two apart and the buffered loop pushed 10 after every line. GNU's `rev` does not. And GNU's `rev` treats `-` as a *filename*, not standard input — the other three take it, which made it look like a convention |
| `nl` | a line and an integer | it **numbered blank lines**, where GNU's default body type does not, so any input with a blank line came out with different numbers from there on. An unnumbered line is padded to seven spaces — the number width plus the length of the separator, not the separator itself |
| `uniq` | one line | terminates a last line that arrived without a newline, which GNU does and `rev` does not |
| `tr` | a chunk | the only state that crosses a chunk boundary is the last byte written, which `-s` needs: a run of `aaa` split across two reads is still one run |
| `grep` | a line | `-q` now stops at the first match, which is the only thing that can stop the stage feeding it — nothing is written, so a refused write never happens |

`sort` is the exception, as this issue said it would be, but for a narrower reason than "it holds its
input". It holds the *lines*, in a vector, rather than one array of bytes — which is the difference
between bounded by memory and bounded by one wasm array, where `seq 1 200000000 | sort` used to trap.
And the sort itself was an insertion sort with a comment saying the inputs are a shell pipeline's
worth: 100,000 lines took four seconds against GNU's none. It is a bottom-up merge sort now, stable,
and the same input takes one.

Measured after: `seq 1 2000000000 | grep -q 5` answers in 0.1s where it would have counted to two
billion; 20 million lines through `rev` takes 2s, through `uniq` 2s, through `nl` 6s.

Thirty-odd differential cases, and every one of the three wrong answers above has one of its own —
including the case that says which tools terminate a final line and which do not, because that is a
fact about four separate programs and no amount of reasoning would have produced it.
