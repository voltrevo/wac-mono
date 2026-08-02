# box — a busybox, written in wac

Fifty-two applets in one program, chosen by the first argument. No TypeScript: `src/` is
wac and the only thing outside it is the test suite.

It exists to exercise `packages/platform`'s capability world more widely than a single
example could, and to be honest about what that world cannot yet do. Where an applet
falls short of the real tool, it says so in its own file.

```sh
deno task app:build packages/box/src/box.wac --allow-read --allow-write -o box
./box grep -i wac README.md
cat README.md | ./box sort -u | ./box wc -l
./box du packages
./box gzip data | ./box gunzip | ./box sha256sum
```

```
base32 base64 basename cat cp crc32 cut date dirname du echo false find
fold get grep gunzip gzip head hex json ls mkdir mv nl paste rev rm rmdir
seq serve sha256sum sha512sum shuf sort sponge stat strings tac tail tee
touch tr true uniq unzstd urldecode urlencode uuid wc yes zstd
```

111K, drawing on this repo's `crypto`, `codec`, `regex`, `gzip`, `datetime` and `url`
packages, so it is the widest composition here.

**Several applets are a few lines over a package.** `gzip` is `gzipBest`, `date` is the
clock capability and `rfc3339.format`, `crc32` and `urlencode` likewise. Those packages
were written to be called from TypeScript through bindgen and needed no change at all to
become the inside of a program instead — which is the thing worth showing.

**One applet per file.** `applets/<name>.wac`, always — finding one takes no thought, and
two people editing different applets do not collide in a 561-line file. `box.wac` is the
dispatcher and its forty imports are the table of contents; shared parts live in
`lib/` (`args`, `bytes`, `num`, `lines`, `input`). Splitting thirty files cost 12ms of
build time, measured before and after.

`true` and `false` are the exception: the dispatcher returning a constant *is* the whole
applet, and a file containing one `return` would be ceremony rather than clarity. Its tests are differential against the system tools rather than against
my idea of them: `cat rev nl tac sort sort -r sort -u uniq -c base32 base64 sha256sum
sha512sum grep grep -i grep -v grep -n grep -c find` all match byte for byte, `du` matches
`du -sb`, and `head -N`, `tail -n N`, `wc -l/-w/-c` match the real ones' output. `grep`
returns 1 on no match and 2 on a bad pattern, as it should. The second batch is checked the
same way: `cut -d -f`, `tr` with ranges, `fold -w` and `strings -n` against the system
tools, and `gzip`/`gunzip` against the system `gzip` in *both* directions, so neither side
can be wrong in a way the other cancels out.

Three things it exercises that nothing else did. **One shared option parser** — without it
`head` was fixed at ten lines and `wc` could not do `-l`, so a dozen applets were
approximate rather than real. **A recursive walk**, in `find` and `du`, which is the first
thing to push on `readDir` and `stat` beyond one level. **The write path**, in `cp` and
`tee`; `cp` needed no new capability at all, being `readFile` and `writeFile` — though it
is now `readFile`, `writeFile` and `rename`, so that an interrupted copy cannot leave a
half-written destination.

**It also shows what a multicall binary costs.** `box`'s grants are the *union* of what
its applets need, so `box echo` carries the filesystem access `box cat` wants. Built as
separate executables, each would state its own: `wc` needs nothing at all and its shebang
would say `deno run` with no flags. One binary with forty-two entry points is the shape
BusyBox has to take; it is not the shape this model is best at.

`bin/` shows the other shape, and measures it rather than asserting it. Four applets are
also built alone — the entry point is four lines and imports the applet file unchanged:

| built alone | shebang | size |
| --- | --- | --- |
| `wc` | `#!/usr/bin/env -S deno run` | 47K |
| `sha256sum` | `#!/usr/bin/env -S deno run` | 51K |
| `grep` | `#!/usr/bin/env -S deno run --allow-read` | 59K |
| `cp` | `#!/usr/bin/env -S deno run --allow-read --allow-write` | 47K |
| `box` | `#!/usr/bin/env -S deno run --allow-read --allow-write` | 111K |

`wc` and `sha256sum` come out with **no permissions at all** — they read standard input
and write a line, and a program that only does that needs nothing from anyone. Handed a
filename, that `wc` says `wc: README.md: filesystem read not granted` and exits 1; it
cannot be talked past its shebang. Under `box` the same applet carries `--allow-write`,
because `cp` is in the binary.

That is also why `Args` carries a `name`. A program in this model is never handed its own
argv[0] — argv starts at its first real argument — so the standalone `wc` would otherwise
have reported errors as `box:`. Under `box` the name is the applet's; in `bin/` the entry
point passes it.

## The two that are not filters

```sh
box serve -8080          # an HTTP server
box get example.com /    # an HTTP client
```

`serve` is `packages/server`'s `serve(input, now)` — a pure state machine, bytes in and a
response out — wrapped in a socket loop. `get` sends a request and hands the reply to
`packages/http`'s parser. Neither package needed a change to be put on a socket, which is
the thing worth showing: they were written for TypeScript bindings and tested against
byte fixtures.

`serve` handles **one connection at a time**, because the world has no `poll`. That is the
honest limit of a synchronous capability world. It is also why there is no `nc`: netcat
must watch standard input and a socket at once, and nothing here can.

`-o` serves one connection and exits. Not `-1` — a leading digit is how this argument
parser spells a number, so `serve -8080 -1` listened on port 1.

## sponge, and why the mutation tier exists

```sh
box sort f | box sponge f     # works
box sort f > f                # truncates f before sort reads it
```

`sponge` soaks up all of standard input and only then touches the target, through
`lib/safe.wac`'s write-beside-and-rename. It is the applet that makes the point of the
mutation tier visible rather than buried inside `cp`.

## What streams and what does not

Memory scales with the input only where it has to. The audit is worth stating explicitly,
because "cannot stream" turned out to be wrong twice:

| | applets | why |
|---|---|---|
| **Streams** | cat wc hex crc32 tr strings gzip gunzip head tail nl rev uniq grep cut fold cp | bounded by a chunk, a line, or a flag |
| **Cannot** | sort tac | need every line before emitting the first |
| **Cannot** | tee | two sinks at once, and the world has one current output |
| **Could, given an API** | sha256sum sha512sum | `crypto` hashes a whole message; it wants `Start`/`Update`/`Finish`, which `crc32` already has |
| **Could, given an API** | base64 base32 | `codec` encodes a whole array, including the padding, so a chunk cannot be encoded on its own |
| **Cannot** | zstd unzstd | `packages/zstd` has no streaming form — a package limit, not the world's |
| **Not worth it** | urlencode urldecode basename dirname date echo seq json stat uuid shuf paste sponge | the input is a line, or the job needs all of it anyway |

Two that are easy to get wrong: **`tail` streams** — it has to *reach* the end but only
has to *hold* N lines, so a ring of N costs what the flag asks for. **`head` need not
reach the end at all**, and stops reading once it has its lines: `head -1` of a 176MB file
returns in 0.036s.

`cp` streams through `lib/safe.wac`, which writes beside the target and renames into
place. That needed `openOutput`: without it a program could not produce more output to a
file than fits in memory, and `cp` of a 176MB file peaked near a gigabyte.

## Layout

```
src/box.wac        the dispatcher, and the table of contents
src/applets/       one applet per file, always src/applets/<name>.wac
src/lib/           args, bytes, num, lines, input, reader, safe
src/bin/           four applets built as standalone programs
test/box.test.ts   every applet against the utility it imitates
```

## The tests are differential

Each applet is compared against the real tool rather than against anyone's idea of it.
That is not a stylistic preference: it is how `nl` numbering blank lines and `rev`
reversing bytes rather than characters were both found, months of use apart, and a
hand-written expectation would have enshrined both.

It also caught that a missing final newline is not handled uniformly by the real tools —
`head`, `tail` and `rev` preserve it, `nl` and `uniq` add one — which no amount of
reasoning from first principles would have produced.
