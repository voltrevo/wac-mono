# 0098 — `box tr` ignores backslash escapes, and `ls` reads an unknown flag as a filename

- **Status:** open
- **Reported by:** agent-c
- **Date:** 2026-08-07
- **Kind:** bug
- **Symptom:** wrong answer

Two applets take an argument literally where GNU interprets it. Found while typing into the
browser terminal rather than by any test, which is the point of them being together here:
both are the *first* thing a reader tries, and both answer without an error.

## Reproduction

```sh
seq 1 3 | tr '\n' ' '
```

Expected (GNU): `1 2 3 ` — `tr` interprets `\n` as a newline.
Actual: `1\n2\n3\n`, unchanged. The set is taken as the two characters `\` and `n`, neither
of which is in the input, so it is a no-op. Same for `\t`, and presumably `\\`, `\r` and the
octal forms.

```sh
ls -l /
```

Expected (GNU): `ls: invalid option -- 'l'`.
Actual: `ls: cannot access '-l': No such file or directory` — every argument that is not
`-a` becomes a path.

## Notes

`ls` is the milder of the two and is documented: its doc comment in `packages/sh/src/exec.wac`
says `-a` is the only flag, for a stated reason (`readDir` does not mark a leading dot, so
hiding them would mean inventing a rule). What is not intended is *how* it declines — listing
a flag as a missing file reads as a broken filesystem rather than an unimplemented option, and
the fix is one branch: an argument starting with `-` that is not `-a` is an invalid option.

`tr` is the real one, because it is silent. A no-op translation looks like working software
until you check the bytes, and the escape forms are most of what anyone types `tr` for.

Neither shows up in the bash differential corpus — that corpus compares *shell* behaviour, and
these are applets. Worth asking whether the applets deserve a differential of their own against
GNU coreutils, which is the check that would have caught both without anyone noticing them by
eye.
