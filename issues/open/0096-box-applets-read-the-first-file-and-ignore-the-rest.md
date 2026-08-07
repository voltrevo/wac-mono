# 0096 — box applets read the first file and ignore the rest, silently

- **Status:** open
- **Claimed by:** agent-a (`cat` done; the rest is the issue)
- **Reported by:** agent-a
- **Date:** 2026-08-07
- **Kind:** bug
- **Symptom:** wrong answer

Found by using the program by hand rather than by a test — which is the point, because every test in
`packages/box` passes one file.

```
$ box cat a.txt b.csv          $ cat a.txt b.csv
hello                          hello
world                          world
hello                          hello
                               x,1
                               y,2
```

No error, no warning, exit 0. The same for `sort`, `nl`, `tac`, `cut`, `grep`, `wc`, `head`, `tail`,
`sha256sum` and `sha512sum` — **ten measured, and the shape is shared by most of the thirty-odd applets
that take an input**: `openStream(core, cli, a, 0)` and `readInput(core, cli, a, 0)` read operand zero and
nothing looks at the rest.

`wc` has a second, related bug: `wc -l a.txt` prints `3` where GNU prints `3 a.txt`, so the filename
appears without a flag and vanishes with one.

## Why this matters more than a missing feature

An input that cannot be seen is reported as absent. `wc -l *.txt` in a directory of twelve files answers
about one of them and says nothing, `grep pattern *.c` finds matches in the first file only, and both look
exactly like a correct answer. This repo has spent a lot of effort on that shape in parsers of other
people's bytes; it was sitting in the one program a person actually types.

## Done so far

`cat` is fixed and matches GNU for one file, several files, and standard input. The plumbing is in
`src/lib/input.wac`:

- `operandCount(a, n)` — how many files this invocation names.
- `nextSpan(core, cli, a, at, opened)` — the next chunk, rolling on to the next file when one ends, so a
  streaming applet sees the operands as one stream with joins in it.

## What is left, and it is not all the same job

- **Concatenating applets.** `nl`, `cut`, `rev` and `fold` are **done** — they read through `Reader`,
  which spans operands, and match GNU on several files. Left: `tr`, `strings`, `hex` (streaming, need
  `nextSpan`), and `sort`, `tac`, `base32`, `base64`, `urlencode`, `urldecode`, `shuf`, `json`, which read
  the whole input through `readInput` and need the same treatment there.
- **`uniq` is not in that group, and putting it there was a mistake.** GNU's `uniq [INPUT [OUTPUT]]` takes
  a second operand as an *output file* — `uniq a b` writes to `b` — so reading it as a second input is
  wrong twice over: it produces the wrong answer and, in GNU, would have overwritten the file. Converting
  it was caught by comparing against the real tool, which is the argument for doing that rather than
  reasoning about it. **box's `uniq` ignores the OUTPUT operand entirely**, which is its own gap and is
  not fixed here.
- **Per-file presentation** — `wc` (a line each plus a total), `grep` (a `file:` prefix when there is more
  than one), `head` and `tail` (`==> name <==` banners), `sha256sum`/`sha512sum` (a line each), `crc32`.
  These need their own output changes, not just a different reader.
- **Already multi-operand, and correct** — `cp`, `mv`, `paste`, `diff`, `tar`, `split`. Do not "fix" these.

A caller that names a file which cannot be opened stops there, where GNU carries on and exits 1 at the
end. That difference is deliberate for now and worth revisiting with the rest — but it **does** exit 1:
`Line.ok` false cannot distinguish "no more lines" from "that file would not open", so `Reader` carries a
`broken` flag and every converted applet checks it. Without that the first version printed the earlier
files and exited 0, which is the failure this whole issue is about, one level up.


## A second family, found the same way — agent-a, 2026-08-07

Using the program by hand again, this time with arguments a person mistypes rather than files:

- **`fold -w0` never finishes.** `end = start + 0` leaves `start` where it was, so the inner loop emits an
  empty line for ever; through a pipe that is an out-of-memory kill rather than a hang. GNU says
  `fold: invalid number of columns: '0'`. Fixed, in those words.
- **`split -0` exited 0 having done nothing.** GNU refuses it. Fixed.
- `fold -w-1` folds nothing and exits 0 where GNU refuses — the argument parser does not see `-w-1` as a
  negative number, which is a parsing question rather than this one, and is **not** fixed.
- `tac` on a file with no trailing newline adds one; GNU does not. Not fixed.
- `cut -c` is not implemented at all — it prints a usage and exits 2, which is the right shape for a gap.

Both fixed cases are now in `test/box.test.ts`, along with multi-file cases for `cat`, `nl`, `rev`, `fold`
and `cut`. **Nothing in the suite passed a zero or a second file before this**, which is why a loop that
never terminates lived in a program with 33 passing tests.


## The three answers, and which applet gets which — agent-a, 2026-08-07

Converting them one batch at a time made it clear this is not one question but three, and the real tool
decides which:

1. **Read them all.** `cat`, `nl`, `cut`, `rev`, `fold` (streaming, through `Reader`/`nextSpan`), `sort`,
   `strings` (whole-input, through `readAll`). Done, each compared against the real one on two files.
2. **Read each, separately.** `tac` — it reverses *each file* in the order named, not the concatenation.
   The two answers differ only when a file's lines are not a palindrome, and the first fixture I used was
   one, so the wrong version looked right. Done.
3. **Refuse the extra.** `base64`, `base32`, `shuf`, `tr` answer "extra operand" in GNU, and `uniq`'s
   second operand is an *output file*. I converted all four to read several before checking, which would
   have invented an incompatibility — and reverting them restored the original silent truncation, which is
   worse. `tooManyOperands` is the third answer, and it is what the real ones do.

Still to do: the per-file presentation group — `wc` (a line each plus a total, and the filename that
currently appears without a flag and vanishes with one), `grep` (a `file:` prefix when there is more than
one), `head` and `tail` (`==> name <==` banners), `sha256sum`/`sha512sum` (a line each), `crc32`. These
need output changes rather than a different reader, which is why they are last.
