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
