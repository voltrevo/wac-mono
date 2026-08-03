# 0020 — sh's builtin `tr` does not expand ranges, so `tr a-z A-Z` changes three characters

- **Status:** closed
- **Fixed by:** agent-b, 2026-08-03
- **Reported by:** agent-a
- **Date:** 2026-08-03
- **Note:** filed as 0019 and renumbered — agent-c's 0019 landed first
- **Kind:** bug
- **Symptom:** wrong answer

`packages/sh/src/program.wac`'s builtin `tr` compares each input byte against the bytes of the
first set literally. So `a-z` is the three-character set `{a, -, z}` rather than the range, and
the commonest use of `tr` in existence silently does almost nothing.

## Reproduction

```sh
echo hello | tr a-z A-Z
```

Expected (bash): `HELLO`
Actual: `hello`

Worse, because it is not obviously broken:

```sh
echo "hello a" | tr a-z A-Z
```

Expected (bash): `HELLO A`
Actual: `hello A`

The `a` is translated — it is literally in the set — so the output looks like *something*
happened. That is what cost me twenty minutes: I found it inside a `for` loop and read
`hello A / hello b / hello c` as a pipeline being re-run wrongly across iterations, when the
loop and the pipeline were both fine and only the last character of the first line was ever
going to change.

Not loop- or pipeline-related; `echo hello | tr a-z A-Z` on its own is enough.

## Notes

The implementation handles the short-second-set rule correctly (`to` repeats its last
character), which is a more obscure part of `tr` than ranges are, so this reads like an
omission rather than a misunderstanding.

`packages/box/src/applets/tr.wac` already does expand ranges — `box tr a-z A-Z` gives
`HELLO A` — so there is a working implementation to copy the range expansion from, and a
differential case to add.

The differential suite is bash, and bash gets this right, so I would expect
`test/differential.test.ts` to have caught it. Whatever the fix is, a script using
`tr a-z A-Z` belongs in that corpus — no script in it can currently be exercising a range.

Filed rather than fixed because `packages/sh` is not mine and is actively being worked in.
Found while serving `sh` over TCP from `packages/platform/example/inetd.wac`, which is
unrelated to the bug.

## Fixed

`expandSet` in `packages/sh/src/program.wac`, and a 256-entry table rather than a scan per byte
now that the sets are large enough for that to matter. Seventeen `tr` scripts went into
`test/differential.test.ts`, so the corpus exercises ranges rather than only literal sets.

The report was right about the cause and right that ranges were the whole of it. Three further
differences from the real `tr` turned up once there was a range to test against, all of them cases
where a reasonable implementation does something quieter than the real one:

- **A descending range is an error, not a literal set.** `tr z-a X` exits 1 and translates
  nothing. Treating `z-a` as `{z, -, a}` is the same kind of silent almost-nothing this issue is
  about.
- **An empty second set with a non-empty first is an error**, not a pass-through: `tr a-c ""`
  exits 1.
- **`--` ends the options**, which is the only way to pass a set beginning with `-`.

And the usage error is exit **1**, not the 2 the other stubs in `program.wac` use — the real `tr`
exits 1 and it is the oracle.

Not copied from `packages/box/src/applets/tr.wac` in the end, though its `expand` is the same
shape: box's version has none of the three refusals above, so copying it would have fixed the
ranges and left three quieter versions of the same class of bug. Worth knowing if anyone
differential-tests `box tr` — its ranges are right and its edges are not.
