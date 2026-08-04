# 0032 — `sh` never reads its own standard input, so `cat` and `read` see nothing

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-a
- **Date:** 2026-08-04
- **Kind:** bug
- **Symptom:** wrong answer

A command inside a script gets the shell's remaining standard input — `dispatch(sh, argv,
sh.restOfStdin())` in `exec.wac` — and `sh.stdinBytes` is only ever filled by a redirection, a
here-document or a pipeline. Nothing ever fills it from the shell's *own* standard input, so it stays
empty for the whole run.

`entry.wac` calls `cli.readStdin()` in exactly one place: when there is no script argument, because
then the script itself is what is piped in. Every other route leaves it unread.

## Reproduction

```sh
deno task app:build packages/sh/src/sh.wac --allow-read --allow-write --allow-env -o /tmp/sh

printf 'a b c\n' | /tmp/sh -c 'cat'          # prints nothing; bash prints "a b c"
printf 'a b c\n' | /tmp/sh -c 'read x; echo "[$x]"'   # prints "[]"; bash prints "[a b c]"
printf 'a b c\n' | /tmp/sh script.sh          # same, for a script file
```

What *does* work, and is why this went unnoticed: `cat < file`, `cat <<EOF`, and anything downstream
of a pipe. Only the shell's own inherited input is missing, which is the one case with no syntax of
its own.

It reaches spawned programs too: `printf 'a b c\n' | sh -c 'wc'` with `wc` on `$WACPATH` counts zero,
because `trySpawn` sends the child `sh.restOfStdin()` and there is nothing in it.

## What a fix looks like

Read it on first need rather than at startup, and only once — a `bool triedStdin` beside
`stdinBytes`, and a `restOfStdin` that fills the buffer the first time it is asked and finds it
empty. `readStdin` reads to the end, which is the right shape here: a script's input is not
interactive, and a shell attached to a terminal blocks until end of input exactly as `cat` does
there.

Two things to be careful of, both of which is why this is filed rather than done in passing:

- **The interactive shells must not do it.** `packages/box/example/term.wac` and
  `packages/ssh/src/sshd.wac` build their own `Shell` and feed it lines; a `cat` in the browser
  terminal that blocks on a standard input the page does not have would wedge the tab. A page's
  `readStdin` answers empty, so it is probably fine there and definitely worth checking rather
  than assuming.
- **It is the shell's cursor, not a copy.** `read a; cat` must give `cat` what `read` left, which
  the existing `stdinPos` already does — the fix has to fill the same buffer, not shadow it.

## Notes

Found while fixing 0021: a spawned `wc` came back counting zero, which looked like a spawn bug and
is not. Independent of 0021, and older.

`packages/sh/test/differential.test.ts` compares against bash and would have caught this if any case
piped anything into the shell — every case passes a script and reads nothing. A case that does
belongs with the fix.
