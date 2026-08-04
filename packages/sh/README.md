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

`test/differential.test.ts` runs 499 scripts through GNU bash and through this, and requires the
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

## `rm -f` and what the platform can say

`-f` ignores what is already gone, not everything that fails. That distinction needed the platform:
`remove` used to answer `bool`, so "no such file" and "permission denied" were the same answer and
`-f` could only swallow both — it said nothing, exited 0, and left the file where it was. The
capabilities carry the host's message now, and existence is a separate question, so the two cases are
told apart without reading the message's words.

## External programs, and the seam

Every external command goes through **one seam**, and there are now two things on the other side
of it.

A **spawned worker** first, if `$WACPATH` names one. `Cli.spawn` arrived after this package did,
and the shell uses it: a program on `$WACPATH` is started as a real child, fed the pipeline's
input, and its output and exit status are the command's.

```sh
deno task app:build packages/platform/example/wc.wac --worker -o /tmp/bin/wc
wacsh -c 'WACPATH=/tmp/bin; seq 1 5 | wc | rev'
```

**`$WACPATH` and not `$PATH`**, deliberately. What `spawn` starts is a wac program built as a
worker bundle; `/usr/bin/wc` handed to it is JavaScript that does not parse. Searching the real
path would therefore turn every working command into a spawn failure, which is a worse answer than
the one we already had. It also makes the whole thing opt-in: with `$WACPATH` unset nothing is
spawned and the behaviour is exactly what it was.

There is no `/bin/ls`, and there is not going to be:
[issue 0015](../../issues/closed/0015-platform-cannot-start-a-process-so-a-server-cannot-run-a-command.md)
was closed `wontfix`, so running host programs is a settled non-goal rather than a pending gap.
What replaces it is a wac program run with grants the parent chooses — which is more than this
package expected to settle for.

Then **whatever was handed to the shell**, through `Shell.external`. `packages/box` has sixty
applets and this package is one of its dependencies, so it cannot import them — the wiring goes the
other way, and it is one line:

```wac
Shell sh = Shell.create(core, cli);
sh.external = boxRun;              // from packages/box/src/shrun.wac
```

With that, `sort`, `sha256sum`, `gzip`, `cut`, `diff`, `shuf`, `tar` and the rest are commands you
can type, running the same code `box` runs on a command line. They are not spawned — `platform`'s
`pushChild`/`popChild` let the shell give a function its own argv, standard input and working
directory and keep what it wrote — so there is no isolation between them and the shell, which is
[issue 0030](../../issues/open/0030-a-page-cannot-spawn-so-the-browser-shell-runs-applets-in-process.md).
It is what makes the browser terminal useful, because a page cannot spawn at all.

Then a **table of programs written in wac**, when nothing else answered:

```
cat wc head tail rev sort uniq grep tr seq nl printf
```

Those twelve exist because, when they were written, nothing could be started and nothing could be
handed over. Both of those are now false, and they have become what the seam always said they
were: a fallback. They are also visibly weaker than `box`'s — this `grep` matches substrings where
`box`'s takes `-ivnc`, this `sort` is an insertion sort — so the sensible end state is to delete
them once something checks that `box`'s pass the same differential scripts against bash. Kept for
now because 539 of those scripts currently agree with bash *through these*, and swapping the
implementation under a passing suite without measuring it first is how a green suite starts lying.

The single seam was the point, and it paid off: wiring `spawn` in changed no part of the pipeline,
redirection, status or `&&` handling, because all of it was already written against `Output`. The
stubs became what they were meant to be — a fallback for when the real program is absent.

**An applet of the shell's own program is spawned, not called.** `Shell.externalSpawnable` says the
names in `externalNames` are applets of *this very bundle* — true for `packages/box`, whose `main`
dispatches on its first argument — and then `trySelf` runs one with `spawnSelf`: its own wasm
instance, its own grants, its own two streams, standing in the shell's own directory. That is a real
boundary where calling was merely convenient, and it is the same route in a browser tab, where it is
the *only* route to a real program. A world that cannot spawn falls through to calling the applet, so
nothing regresses where the capability is missing.

A child is granted what the shell has, which the host narrows to what it actually holds: an applet
run in process had the shell's whole authority implicitly, and asking for it explicitly is the same
authority said out loud.

The first thing a shell trips over is a file on `$WACPATH` that is not a worker bundle, and there
are two of those. One that does not parse is now a failed command with the host's reason and status
126, distinct from the 127 of not existing —
[0021](../../issues/closed/0021-a-spawned-worker-that-does-not-parse-kills-the-parent.md), where it
used to take the shell down with it. One that *parses* and never speaks the bridge protocol — a
built program rather than a `--worker` bundle, most likely — still hangs:
[0033](../../issues/open/0033-a-file-that-parses-but-is-not-a-worker-bundle-wedges-the-shell.md) has
why that is a harder question than it looks.

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
work. The options — `-e`, `-u`, `-x` — are **refused rather than accepted and ignored**, because
a `set -e` that did not stop on an error is worse than one that does not exist. Bare `set` lists this
shell's own variables sorted, which is the same idea as bash's over a much smaller set and so
cannot be compared with it.

**Only `read` consumes standard input.** It advances a cursor the whole command shares, which is
what makes `while read line` terminate rather than see the first line for ever. The external
programs are handed whatever is left but are *not* charged for it, because nothing here knows
which of them read their input — so `{ cat; cat; }` gives both copies of the whole thing where
bash gives the second nothing.

**`cd`, `pwd` and `ls` exist, and the seam moved to make room.** This section used to say they
did not, and that a shell-side `cd` "would mean maintaining `$PWD` here and resolving every
relative path against it before handing it over, in the redirections *and* in `program.wac`'s file
openers… a change to the seam rather than a builtin". That was exactly right, and that is what it
took (agent-a).

`packages/platform` gained one capability, `cwd`, which *reads* where the host resolves relative
paths — and deliberately no `chdir`, because a mutable working directory is ambient state that
changes what every relative path in a program means from anywhere. So the shell asks once at
startup, keeps its own `cwd`, and `Shell.resolve` turns every path into a whole one before it
crosses the boundary. There were nine such places; all nine are routed, because a `cd` that works
for `cat` and not for `>` is worse than no `cd`. The path helpers live in `path.wac` rather than
here, since `program.wac` needs them too and `exec.wac` already imports it.

Eighteen scripts in the differential suite cover it, and each one moves first and then does
something that has to notice — a relative read, a relative glob, a redirection, a listing, `..`
above the root, a failed `cd` leaving the shell where it was.

`ls` is one per line and sorted, which is what any `ls` does when its output is not a terminal;
`-a` is the only flag, and it synthesises `.` and `..` as a real `ls` does, since `readDir` does
not report them.

**No `$0`.** `cli.arg(0)` is the first *argument*, not the program name, so there is nothing
truthful to put there.

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
`?`, `#`, `##`, `%`, `%%`, `${#x}`, substrings (`${x:off:len}`, both numbers arithmetic and both
allowed to be negative), case conversion (`^`, `^^`, `,`, `,,`, with the pattern that selects which
characters are eligible), and `/`, `//` with the `/#` and `/%` anchors — including `&` in the
replacement standing for the matched text, which bash grew in 5.2. Absent: indirection, the `@`
transformations (`${x@Q}` and friends) and the array forms.

A malformed expansion is **fatal**, as it is in bash: `${x:}` prints nothing, exits 1, and
abandons the rest of the line rather than quietly expanding to the empty string. Quietly
expanding to something plausible is the failure mode this package exists to avoid.

**`2>` is refused rather than approximated.** Only standard output is captured, so there is
nothing of the error stream to redirect, and saying so beats writing the wrong bytes to the file.

**Standard error arrives when it happened**, interleaved with standard output as bash's is, which
is what `2>&1` has to show. It used to be collected and flushed at the end through `Core.warn` —
the world had no byte-level error stream — so `echo one; nope; echo two` printed the complaint
last however early it happened. `Shell.err` is the one place that decides: a capturing shell keeps
the bytes for whoever asked for the capture, and a shell attached to a terminal writes them out.
[Issue 0014](../../issues/closed/0014-platform-has-no-way-to-write-bytes-to-standard-error.md) is
the capability that made it possible.

## Coverage

`deno task coverage:sh` drives about 380 scripts through the lexer, parser and executor
with the capabilities faked inside wac — `test/wac/probe.wac` builds a `Core` and a `Cli` out of
pure functions, since wac has no mutable module-level state and a funcref cannot close over
anything. A fixed answer per path is enough to reach both sides of every branch that asks.

**It stands at 97.2%**, not the 100% the rest of this repo holds to, and the shape of what is left
is worth stating rather than leaving as a number.

`parse.wac` is the laggard at 94%, and **every one of its fifteen remaining points is a guard on an
invariant something else already maintains.** Half are `p >= toks.len()`, which cannot execute:
`tokenize` always ends with `Eof`, so the parser stops at that token rather than running off the
end of the list. The rest are the same character — a token with no parts, an empty name, a list
that parsed successfully and came back empty. They are real safety against a caller that does not
come through `tokenize`, and no script reaches them. Worth saying plainly: pushing this number
higher would mean deleting guards, not writing tests.

One point is not a guard and is worth naming, because it is a genuine limit of the probe rather
than dead code: **the branch that appends a chunk from a spawned child**. `test/wac/probe.wac`'s
fakes hold no state, so its `recv` can only answer end-of-input — one that returned bytes would
return them for ever and the read loop would not finish. That branch is covered by
`test/spawn.test.ts` instead, against the real host, which is the only place a child can actually
speak.

### Mutation testing

`deno task mutate --package sh --operators` generates 117 mutants and **all 117 are killed.** That
is a much stronger statement than either number above, and it is the one worth re-running after any
change to this package: coverage says a line ran, mutation says that breaking it on purpose is
noticed. It takes about ten minutes.

Two caveats to keep it honest. It is the guard-and-extreme operator set; `--operators=all` adds
relational and literal mutants and is **3052 mutants**, which has never been run here. And the
per-test selection in `tools/mutate.ts` does nothing at all for this package — every test file
builds a binary and runs it as a child, so the coverage counters are in the wrong process and the
tool reports `0/117 ran only the tests that reach them`. See
[issue 0024](../../issues/open/0024-mutation-selection-is-inert-for-subprocess-tests-and-the-fallback-runs-them-worst-first.md).

The three measurements answer different questions and none replaces the others. bash says what is
*right*; coverage says what has *run*; mutation says what is *noticed*.

The refusals in particular are invisible to the
differential suite by construction — bash and this agree on what works, and differ on what this
declines to do.
