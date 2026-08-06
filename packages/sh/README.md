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

`test/differential.test.ts` runs 652 scripts through GNU bash and through this, and requires the
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

**A spawned program is as trusted as the shell.** It gets `read`, `write`, `net` and `env`, and the
host narrows that to what the shell itself holds, so a shell started with nothing hands its children
nothing — the property that matters was never that a child gets *nothing*, it is that it cannot get
*more*. `GRANT_NONE` was here instead and was never a decision: it was the value the argument had when
`spawn` grew one, and it meant a `$WACPATH` `wc file` could not open the file it was handed while the
shell refusing on its behalf could read it perfectly well.
[0028](../../issues/closed/0028-sh-decides-nothing-about-what-wacpath-programs-may-do.md) set out the
three defensible answers — nothing, the shell's own, or a `WACGRANTS=` variable — and this is the
second, which is what every other shell does.

Then **whatever was handed to the shell**, through `Shell.external`. `packages/box` has sixty
applets and this package is one of its dependencies, so it cannot import them — the wiring goes the
other way, and it is one line:

```wac
Shell sh = Shell.create(core, cli);
sh.external = boxRun;              // from packages/box/src/shrun.wac
```

With that, `sort`, `sha256sum`, `gzip`, `cut`, `diff`, `shuf`, `tar` and the rest are commands you
can type, running the same code `box` runs on a command line. They are *spawned* where the world can
spawn, including in a browser tab — `Shell.externalSpawnable` below is what says they are applets of
this very bundle — and called through `platform`'s `pushChild`/`popChild` where it cannot, which gives
a function its own argv, standard input and working directory and keeps what it wrote. Only the second
of those has no isolation from the shell, and it is now the fallback rather than the only route:
[0030](../../issues/closed/0030-a-page-cannot-spawn-so-the-browser-shell-runs-applets-in-process.md).

Then a **table of programs written in wac**, when nothing else answered:

```
cat wc head tail rev sort uniq grep tr seq nl printf
```

`cat` takes all nine of GNU's flags (`-A -b -e -E -n -s -t -T -u -v`), and `seq` takes all three of
GNU's forms including the increment in the middle — both of which were *filenames and ignored
arguments* until they were compared: `cat -n f` answered "cat: -n: No such file or directory" and
`seq 1 2 9` printed `1 2`. What is still missing is announced as missing: `seq` counts in whole
decimals, so `seq 1.5 3` says fractions are not implemented rather than truncating to something
plausible, and `-f`, `-s` and `-w` say the same.

Those twelve exist because, when they were written, nothing could be started and nothing could be
handed over. Both of those are now false, and they have become what the seam always said they
were: a fallback. They are still weaker than `box`'s — this `grep` matches substrings rather than
regular expressions, this `sort` is an insertion sort — so the sensible end state is to delete them
once something checks that `box`'s pass the same differential scripts against bash. Kept for now
because 652 of those scripts currently agree with bash *through these*, and swapping the
implementation under a passing suite without measuring it first is how a green suite starts lying.

**They read their operands**, which for nine of the twelve they did not: `wc`, `head`, `tail`,
`sort`, `uniq`, `rev`, `nl` and `grep` ignored every file named on the command line and read standard
input regardless. `wc -l f` printed `0` and exited `0`. `grep pattern f` printed nothing and exited
1, which a script reads as "no match" rather than "the file was never opened". `cat` was the only one
that had ever opened anything, and it is the reason `run` takes a `cwd` at all. Several operands
change the shape of the answer and that shape is GNU's: `wc` names each file and totals them, `head`
and `tail` write a `==> name <==` header per block, `grep` labels its lines, and `sort`, `nl` and
`rev` treat the operands as one concatenation. A file that cannot be read carries each program's own
status — 1 for most, 2 for `sort` and `grep` — and only `sort` gives up rather than answering over
what it could read.

**An option none of them has is refused.** It used to fall through to whatever the program did with a
stray argument, which was never nothing: `grep -c a f` searched for `-c`, `sort -n` sorted as text,
`wc -m` counted everything. `grep` now takes `-cinqvx`, `wc` `-lwc`, `sort` `-r`, `head`/`tail` the
count in both spellings, and anything else is a usage error with GNU's status.

Two deliberate differences remain, both refusals rather than approximations. `uniq f g` *writes* `g`
in GNU; here it is refused, because a write nobody asked for is worse than a missing feature. And a
diagnostic goes to standard error in one piece after the output rather than interleaved with it,
which is the seam again — the fallback programs hand back two finished byte strings.

**`tr` matches GNU.** `-c`, `-d`, `-s`, `-t`; `\n`-style escapes, and GNU's set of them rather than
`printf`'s, so `\x41` is an `x`, a `4` and a `1`; all twelve `[:alpha:]` classes; `[c*n]` repeats and
`[c*]` padding, octal counts included; `[=c=]` equivalence classes. It did none of that until bash was
asked: `-d` was read as the two-character set `{-, d}`, so `tr -d 12` translated digits into a dash and
a `d` and reported success; `tr : '\n'` produced a backslash and an `n`; `[:digit:]` was eight literal
characters. The repeats and equivalence classes were *refused* for one afternoon, and the refusal is
gone because a refusal is not the goal — see the next paragraph.

**Three answers to a gap, and they are not equally good.** Doing something plausible anyway is the
worst: it is a wrong answer with nothing to notice, which is what every bug in the paragraph above
was. Refusing is better. Saying *which side is incomplete* is better still, and is the only one of the
three that is true — a caller who writes `wc -m` has written a real flag, and "invalid option" tells
them their command is wrong when this program is merely unfinished.

So the two messages are two different facts. A letter GNU has not got either keeps GNU's own wording:
`wc: invalid option -- 'Z'`. A letter GNU has and this does not says so: `wc: -m is not implemented`,
`grep: -E is not implemented`, `test: -r is not implemented`, `sh: redirecting fd 2 is not
implemented`. `gnuHas` in `program.wac` holds the letters, read out of the tools' own `--help`, and
`test/gaps.test.ts` asserts the property against the installed coreutils: **no option GNU has is ever
called invalid.** It fails if the table drifts, and it fails if a new refusal picks the wrong wording.

The single seam was the point, and it paid off: wiring `spawn` in changed no part of the pipeline,
redirection, status or `&&` handling, because all of it was already written against `Output`. The
stubs became what they were meant to be — a fallback for when the real program is absent.

**A pipeline runs its stages at once**, where every stage is a program the shell can spawn.
`seq 1 200000 | head -1` takes 0.15 seconds rather than 11.8, and 0.07 seconds in a browser tab, which
is the same code. One `recv` in flight per open stream, `waitAny` over all of them, and a stage whose
reader has finished is stopped.

**And now it is `SIGPIPE` in every way that matters.** This paragraph twice said otherwise, and both
times it was right at the time: the seam was bytes in and bytes out, so a program had produced nothing
until it had produced all of it, and stopping a stage stopped a worker that had already been asked to
do the whole job. The programs write through a `Sink` as they go now
([0061](../../issues/closed/0061-sh-applets-return-all-their-output-at-once-so-a-large-stage-dies.md)),
so `seq 1 2000000000 | head -1` prints `1` in 0.13 seconds where it used to trap after five, and
`seq 1 200000000 | wc -c` prints GNU's own answer where it printed nothing and exited 126.

**A lone command streams too.** One stage is the same machinery as six, and a single command used to be
the collecting case: `wacsh -c 'seq 1 2000000000'` built twenty gigabytes in the shell and trapped at
one wasm array, and `cat missing f` printed its complaint and `f`'s contents in whichever order the two
buffers happened to be flushed rather than in the order they happened. `canStream` takes a pipeline of
one, and a lone stage may *inherit* the real standard input — streaming and shared, which is what makes
`cat; cat` print one line between them as bash does.

`canStream` decides before anything is expanded, because expansion runs command substitutions and
asking twice would run them twice: every stage must be a plain command whose name is a bare literal
naming one of this program's applets, with no redirection and no prefix assignment. Everything else
takes the sequential path — a builtin *is* the shell, a function lives in its table — which is
unchanged and still gathers. That boundary is visible rather than silent: `{ echo a; } | rev` gathering
is fine, `seq | head` gathering was the bug. Issue 0038.

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
used to take the shell down with it. One that *parses* and never speaks the bridge protocol — a built
program rather than a `--worker` bundle, most likely — used to hang for ever, and is now a failed
command too: every bundle carries a marker on its first line, so a file that is not one is refused
before a worker starts, and one that claims to be and then says nothing is failed by a five-second
grace rather than waited on.
[0033](../../issues/closed/0033-a-file-that-parses-but-is-not-a-worker-bundle-wedges-the-shell.md) is
why the marker had to come first: the timer alone would have traded the hang for a false "cannot
execute" on a loaded machine.

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

**`wc`'s columns are seven wide when its input is standard input, where GNU's are sometimes
narrower.** GNU takes the width from the digits of the total size of its inputs and falls back to 7
when it cannot know one, which is what a pipe is: `seq 1 5 | wc` is seven wide in both. But GNU asks
the *descriptor*, so `wc - < f` on a 108894-byte file gives six-wide columns, and nothing here can
ask — there is no `fstat` in the capability world, and a redirection reaches a spawned program as
bytes over a bridge rather than as a file. So that one case prints wider than GNU's.

It is a gap and not a preference: what it would take is a capability that reports the size of
standard input. Both of this shell's paths agree with each other meanwhile — the in-process one holds
the redirected bytes and *could* answer 6 — and consistency was the thing worth keeping, because a
`wc` whose output depended on whether the shell could spawn would be the harder bug to find.

The same missing size costs one more thing, and it is worth naming because it looks like a bug: `wc`
cannot print a file's counts *until it has read every input*, since the width depends on the total. So
`wc -l f missing` prints its complaint after the counts where GNU prints it between them. GNU gets both
because `fstat` tells it the widths before it reads anything. `cat` has no such constraint and does
interleave correctly — see `complain` in `program.wac`, which flushes the output sink before writing to
the error one, because a 64 KiB buffer is enough to reverse the two.

**A file whose name is not valid UTF-8 can be listed and not opened, and it says so.** `ls` shows
`bad-\ufffd-name` where bash shows the real bytes, and every program that tries to open that name reports
`cannot be named on this host` rather than `No such file or directory`. bash handles these files perfectly,
so this is a genuine divergence rather than a gap in the shell.

The loss is not ours and cannot be fixed here: `Deno.readDir` replaces invalid bytes with U+FFFD, and
`Deno.stat` of the name it just returned fails — there is no byte-oriented path anywhere in that API. wac
strings *are* byte arrays, so a name would survive the bridge; it does not survive the runtime. Node's `fs`
takes a `Buffer` and could do it, which is why the fault category exists rather than a blanket refusal:
`FAULT_NOT_REPRESENTABLE` is a fact about the host, and a host that can express the name will not raise it.
wac-mono 0065.

**`test` refuses rather than answering, and this is a deliberate divergence from bash.** `test -e` on such
a name exits **2 with a diagnostic** instead of the `1` bash would give, because bash's `1` is the truth
there — bash looked and the file is absent — while ours would be a guess about a file we know is present
and cannot examine. A script acts on `false`; it stops on a 2. The same reasoning gives `ls` the sentence
`cannot access 'x': cannot be named on this host` where a genuinely missing operand still gets GNU's
`No such file or directory`, exactly.

**The whole script is parsed before any of it runs, and bash does not do that.** `echo a` followed by a
line beginning `&& echo b` prints `a` in bash and then fails with a syntax error, because bash reads,
parses and executes one line at a time; ours prints nothing and exits 2, having refused the script as a
whole. Both exit 2, and every valid script agrees — this shows up only where a script is *partly* valid.
Found by a mutation sweep: `isNewline` in `parse.wac` could be replaced with `return false` and all 614
corpus cases still passed, because every one of them was a single line. The continuations that function
exists for — a newline after `&&`, `||` or `|` — are in the corpus now, and the partly-valid case is here
rather than there because the corpus asserts agreement.

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

**`~` is `$HOME` and nothing else.** `~`, `~/x`, `cd ~`, `> ~/f`, and one after every colon in an
assignment (`PATH=/usr/bin:~/bin`, which has to expand or the shell keeps a directory called `~` on
its search path). Left exactly as written: `~user`, because naming somebody else's home means
reading the password file and no capability offers it — bash also leaves a user it cannot find
alone — and `~+`/`~-`, which are `$PWD` and `$OLDPWD` under a spelling almost nobody types. With
`HOME` unset bash asks the password file and this leaves the word alone, which is the only case
where the two disagree; the differential suite therefore compares `~` with `HOME` set, in the same
test as `cd` and `cd -`, since all three read it.

**No `$0`.** `cli.arg(0)` is the first *argument*, not the program name, so there is nothing
truthful to put there.

**No process substitution.** `<(…)` needs a pipe with a name, which the capability world does
not offer.

**A redirection still collects.** Everything else streams — the stages of a pipeline, a lone command,
and the programs themselves through `Sink` — but `> file` gathers the command's output in the shell and
writes it afterwards, so a redirected command is bounded by memory however well it streams:
`seq 1 2000000000 > out` traps where bash writes twenty gigabytes.
[Issue 0070](../../issues/closed/0070-a-redirection-collects-a-childs-whole-output-before-writing-the-file.md)
is that, with `openOutput` named as the capability it wants. `2>` and `2>&1` are not implemented at
all, and say so.

**The programs stream, and `sort` holds lines rather than bytes.** Each reads a chunk or a line at a
time: `cat` and `tr` a chunk, `head`, `tail`, `wc`, `rev`, `nl`, `uniq` and `grep` a line — and `grep -q`
stops at the first match, which is the only thing that can stop the stage feeding it, since nothing is
written and a refused write never happens. `sort` is the exception and it is a narrow one: it holds every
line, because that is what sorting is, but as lines in a vector rather than one array of bytes, which is
the difference between bounded by memory and bounded by one 1.9 GB wasm array. Its insertion sort became
a bottom-up merge sort at the same time — 100,000 lines took four seconds and now takes one.
[0071](../../issues/closed/0071-nine-of-shs-programs-read-all-of-their-input-before-answering.md) has the
table of what each program turned out to be doing wrong, which was three things nobody was looking for:
`rev` added a newline that was not there, `nl` numbered blank lines, and `rev` took `-` as standard input
where GNU takes it as a filename.

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

**`2>` is not implemented, and says so in those words.** Only standard output is captured through the
seam, so there is nothing of the error stream to redirect — and the message names the gap rather than
the command: this shell is unfinished here, and the caller who wrote `2>err` was not wrong.

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
[issue 0024](../../issues/closed/0024-mutation-selection-is-inert-for-subprocess-tests-and-the-fallback-runs-them-worst-first.md).

The three measurements answer different questions and none replaces the others. bash says what is
*right*; coverage says what has *run*; mutation says what is *noticed*.

The refusals in particular are invisible to the
differential suite by construction — bash and this agree on what works, and differ on what this
declines to do.
