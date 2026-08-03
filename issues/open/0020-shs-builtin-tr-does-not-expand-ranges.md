# 0020 — sh's builtin `tr` does not expand ranges, so `tr a-z A-Z` changes three characters

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
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
