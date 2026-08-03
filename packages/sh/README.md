# sh

A shell, in wac. Quoting, parameter expansion with the `:-`/`:=`/`:?`/`:+` operators, command
substitution in both spellings, arithmetic, here-documents, `read`, pipelines, redirection,
`&&`/`||`, `if`/`while`/`until`/`for`/`case`, functions, subshells, globbing, positional parameters,
exit statuses — checked against GNU bash, script for script.

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

Here-documents are the one construct whose meaning lives on the *following* lines, so they are the
one place the lexer does not read strictly left to right. `<<WORD` parks a request; the next
newline pays all the parked requests off in order, reading body lines until one equals the
delimiter. That ordering is what makes `cat <<A <<B` take A's body first even though both operators
were on the same line. Quoting the delimiter — `<<'E'`, `<<"E"` or `<<\E`, which are the same
thing — turns expansion off for the whole body; an unquoted body is expanded by exactly the
inside-double-quotes rules, and shares the code path with them rather than restating them.

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

Patterns — in globbing, in `case`, and in the `#`/`%` trims — share one matcher, so `*`, `?` and
`[a-z]` mean the same thing in all three. Bracket classes take ranges and `!`/`^` negation, and
follow the two rules that make them writable at all: a `]` immediately after the opening bracket
is a literal `]`, and an unclosed `[` is an ordinary character. That second one is why `echo [`
prints a bracket rather than expanding to nothing.

**`arith.wac`** — the inside of `$((…))`, where the shell's own rules stop applying. A bare name
is a variable, an unset one is zero, and comparisons yield 1 and 0 — the *opposite* polarity to
`test a -lt b`, whose success is 0. Two conventions a few characters apart and the shell means
both.

It evaluates numbers and operators only: **the caller substitutes variables first**, repeatedly.
That split is not squeamishness about coupling. It is what reproduces bash resolving a value that
is itself an expression (`x=1+2` makes `$((x))` 3) and one that names another variable
(`a=b; b=c; c=7` gives 7) — both need the shell's own lookup and a repeat pass. A self-reference
reaches a fixed point rather than growing, so the cycle test is that *no name survives*
substitution, not that the text stopped changing.

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

**`set` does the positional parameters and nothing else.** `set --`, `set a b c` and `shift`
work. The options — `-e`, `-u`, `-x` — are **refused rather than accepted and ignored**, because a
`set -e` that did not stop on an error is worse than one that does not exist. Bare `set` lists this
shell's own variables sorted, which is the same idea as bash's over a much smaller set and so
cannot be compared with it.

**Only `read` consumes standard input.** It advances a cursor the whole command shares, which is
what makes `while read line` terminate rather than see the first line for ever. The external
programs are handed whatever is left but are *not* charged for it, because nothing here knows
which of them read their input — so `{ cat; cat; }` gives both copies of the whole thing where
bash gives the second nothing.

**No process substitution.** `<(…)` needs a pipe with a name, which the capability world does
not offer.

**Pipelines run one stage at a time**, in memory. A real pipeline runs its stages at once, so
`yes | head -1` terminates in bash and would not here. Real processes will not fix that by
themselves: it needs the shell to run stages concurrently, which needs more than one thread.

**Globbing is last-component only.** A pattern in the final path component works; one in a leading
component does not, because that needs walking every directory that matches.

**Loops are bounded** at 100,000 iterations. bash would run forever; this stops and says why,
which matters because the shell runs inside a server that has no way to be interrupted. That is a
deliberate difference and the only one where this refuses to do what bash does.

**Some parameter expansions are missing.** Implemented: `:-`, `-`, `:=`, `=`, `:+`, `+`, `:?`,
`?`, `#`, `##`, `%`, `%%` and `${#x}`. Absent: `${x/a/b}` substitution, indirection and the array
forms.

**`2>` is refused rather than approximated.** Only standard output is captured, so there is
nothing of the error stream to redirect, and saying so beats writing the wrong bytes to the file.

**Standard error arrives in one piece at the end**, as with `packages/ssh` and for the same
reason — [issue 0014](../../issues/open/0014-platform-has-no-way-to-write-bytes-to-standard-error.md).

## Coverage

`deno task coverage:sh` drives about two hundred scripts through the lexer, parser and executor
with the capabilities faked inside wac — `test/wac/probe.wac` builds a `Core` and a `Cli` out of
pure functions, since wac has no mutable module-level state and a funcref cannot close over
anything. A fixed answer per path is enough to reach both sides of every branch that asks.

**It stands at 95%**, not the 100% the rest of this repo holds to, and the shape of what is left
is worth stating rather than leaving as a number. Roughly half of the remainder is `p >=
toks.len()` guards that **cannot execute**: `tokenize` always ends with `Eof`, so the parser stops
at that token rather than running off the end of the list. They are real safety against a future
caller that does not go through `tokenize`, and no script will ever reach them. The rest are
defensive guards of the same character.

The two measurements answer different questions and neither replaces the other. bash says what is
*right*; coverage says what has *run*. The refusals in particular are invisible to the
differential suite by construction — bash and this agree on what works, and differ on what this
declines to do.
