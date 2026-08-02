# sh

A shell, in wac. Quoting, parameter expansion, command substitution, pipelines, redirection,
`&&`/`||`, exit statuses — checked against GNU bash, script for script.

```sh
deno task app packages/sh/src/sh.wac --allow-read --allow-env -- -c 'seq 1 10 | grep 1 | wc -l'
deno task app:build packages/sh/src/sh.wac --allow-read --allow-write --allow-env -o wacsh
./wacsh script.sh
```

A package of [wac-mono](../../README.md) — see the root README for layout and how to run things.
All commands run from the repo root.

## The oracle is bash

`test/differential.test.ts` runs every script through GNU bash and through this, and requires the
same standard output *and* the same exit status. For a shell that is the only test worth much:
the behaviour is defined by what the real one does, and nearly every rule has a case where the
obvious implementation is subtly wrong.

It earned its place on the first run. Three of eighty-three scripts disagreed, all one bug: the
lexer accumulated `x=` and `"a b c"` into a single part and marked the whole thing quoted, so
`x="a b c"` stopped being an assignment and became a command called `x=a b c`. **A part has
uniform quotedness** — that is the invariant, and nothing but bash was going to tell me it had
been broken.

bash runs with `LC_ALL=C` so `sort` compares bytes, as ours does. Without it the locale decides
and the two disagree about case.

## Why the pieces look like this

**`lex.wac`** — a shell lexer cannot throw the quoting away. `echo "$x"` and `echo $x` tokenize to
the same characters and behave differently: the first is one word whatever `x` holds, the second
splits on whitespace and may become zero words or ten. So a word is not a string, it is a list of
parts each of which remembers whether it was quoted.

The three quoting forms suppress different things: `\c` is one literal character, `'…'` suppresses
everything including backslashes, and `"…"` suppresses splitting and globbing but **not** `$`.
Inside double quotes a backslash escapes only `"`, `\`, `$` and `` ` `` — before anything else it
stays a literal backslash, which is why `"\n"` is two characters.

A run of digits immediately before a redirection is a file descriptor, not a word: `2>err`
redirects and `2 >err` writes `2` and redirects. The lexer has to decide, because by the time the
parser sees words the space is gone.

**`parse.wac`** — an assignment is only an assignment *before the first word*. `a=1 echo b` sets
`a` for that command; `echo a=1` prints it. Nothing about the token says which, so the parser
tracks whether it has seen a word yet. Redirections may appear anywhere in a simple command, not
only at the end — `> out echo hi` is legal, and treating them as a trailing clause parses the
common case and quietly drops the other.

**`exec.wac`** — the order is expand, then split, then quote removal, and splitting happens *only*
where the text came from an unquoted expansion. A shell that splits the source text, or that
splits everything, gets `x="a b"; echo $x` or `echo "$x"` wrong. An unquoted expansion that yields
only whitespace disappears entirely: `x=""; echo $x` passes no arguments where `echo "$x"` passes
one empty one.

**`program.wac`** — see below. It is the one interesting thing here.

## External programs, and the seam

The capability world cannot start a process
([issue 0015](../../issues/open/0015-platform-cannot-start-a-process-so-a-server-cannot-run-a-command.md)),
so this shell cannot run `/bin/ls`. Rather than pretend, every external command goes through
**one function** — `program.wac`'s `run` — backed today by a table of programs written in wac:

```
cat wc head tail rev sort uniq grep tr seq nl
```

That single function is the point. When the capability lands, `run` gains a branch that calls it,
and pipelines, redirection, exit statuses and `&&` are already written against the same shape.
The stubs become what they should have been: a fallback for when the real program is absent.

**The signature is the design decision.** Bytes in, bytes out, a status, and a `found` flag —
because a shell reports 127 for "no such command" and the program's own code for "ran and failed",
and one integer cannot say both.

## Over SSH

[`packages/ssh`](../ssh/README.md)'s server runs its commands through this, so a shell script sent
over a channel behaves like one:

```sh
ssh -p 2222 user@host 'seq 1 100 | grep 7 | wc -l'
```

That works because of `Shell.capturing`: standard output collects into a buffer rather than going
to the process's own terminal. Command substitution needs exactly the same thing, so it is one
flag rather than two mechanisms.

## What it does not do

**Pipelines run one stage at a time**, in memory. A real pipeline runs its stages at once, so
`yes | head -1` terminates in bash and would not here. Real processes will not fix that by
themselves: it needs the shell to run stages concurrently, which needs more than one thread.

**No compound commands** — `if`, `while`, `for`, `case`, `{…}`, subshells — and no functions.
The grammar has the place for them; nothing fills it yet.

**No globbing.** A word containing `*` reaches the command unchanged, which is what bash does when
nothing matches, so the difference only shows when something would have.

**No here-documents, backquotes, `${x:-default}`, or arithmetic.** Each is noted in the lexer where
it would attach.

**`a=1 cmd` leaks.** A prefix assignment should apply to that command only; here it is set and
left. The parser distinguishes the two cases correctly, so this is an execution gap rather than a
parsing one.

**`2>` is refused rather than approximated.** Only standard output is captured, so there is
nothing of the error stream to redirect, and saying so beats writing the wrong bytes to the file.

**Standard error arrives in one piece at the end**, as with `packages/ssh` and for the same
reason — [issue 0014](../../issues/open/0014-platform-has-no-way-to-write-bytes-to-standard-error.md).

Branch coverage is not wired up yet; the differential suite is the only measurement.
