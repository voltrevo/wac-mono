# box — a busybox, written in wac

60 applets in one program, chosen by the first argument. No TypeScript: `src/` is
wac and the only thing outside it is the test suite.

That number is a digit rather than a word because it kept going stale: it said fifty-nine when
the dispatcher had sixty, and before that forty-two in one paragraph and something else in
another. `test/box.test.ts` now compares it to the dispatcher, so adding an applet and
forgetting the sentence is a failing test.

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
base32 base64 basename cat cp crc32 cut date diff dirname du echo false find
fold get gets grep gunzip gzip head hex httpd json ls mkdir mv nl paste
nc rev rm rmdir seq serve sha256sum sha512sum shuf sort split sponge stat
strings tac tail
tar tee touch tr true uniq unzstd urldecode urlencode uuid wc wget yes zstd
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
would say `deno run` with no flags. One binary with sixty entry points is the shape
BusyBox has to take; it is not the shape this model is best at.

## In a browser

`example/` holds two browser pages, built with `--target browser` and served with the two
cross-origin isolation headers `SharedArrayBuffer` needs — `box httpd -x` sends them, which
makes the whole loop wac.

**`example/term.wac` is `packages/sh` in a tab**: pipelines, loops, variables, arithmetic and
redirection into a filesystem that survives a reload, with the shell unchanged — **and every
applet in this package as a command you can type**, which is `src/shrun.wac` and one line of
wiring:

```wac
sh.external = boxRun;
```

`sort`, `sha256sum`, `gzip`, `cut`, `diff`, `shuf`, `strings`, `tar`: the same code that runs on a
command line, in the page. It **spawns** them: a worker can create a worker, and `spawnSelf` needs no
filesystem, so `sort` is this bundle again with `sort` as its first argument — its own instance, its
own `SharedArrayBuffer`, its own grants. This paragraph used to say the opposite, because `spawn` was
Deno-only and `platform` grew `pushChild`/`popChild` instead: they give a function its own argv,
standard input and working directory and keep what it writes, and an applet cannot tell which way it
was run.

That is still the fallback, and being indistinguishable is the reason
[0030](../../issues/closed/0030-a-page-cannot-spawn-so-the-browser-shell-runs-applets-in-process.md)
needed a test that could tell them apart: a *called* applet's output is captured and capped at 8 MiB,
so `seq 1 1500000 | wc -c` truncates, while a *spawned* one's queue drains as the next stage reads it
and answers what GNU answers. `platform/test/browser_live.test.ts` checks that in a real Chromium.

A `$WACPATH` program still needs a filesystem of worker bundles and so still does not run in a page —
which is why "run me again with different arguments" is the route that matters here.

Typing into that terminal is also how `sort -n` was found missing: the flag parsed, nothing read
it, and `seq 1 20 | sort -n` answered 1, 10, 11. The words fixture in the differential test could
not catch it — every line counts as zero, so honouring the flag and ignoring it agree. There are
numbers in that test now.

**`example/hash.wac`** hashes and compresses what you type as you type it, from `crypto` and
`gzip` unchanged: 18KB of text to a SHA-256 and 131 gzipped bytes in about a millisecond, on a
worker, so the typing stays smooth.

They live here rather than in `packages/platform/example/` because they need `crypto`, `gzip`
and `sh`, and platform is the package all three sit on top of.

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

## nc, and why it took this long

```sh
box nc host 80              # stdin to the socket, socket to stdout, both at once
box nc -8080 -l             # or listen, and relay one connection
```

I refused to write this three times, and the reason each time was the same: a relay has to
watch **two** sources. Wait on the socket alone and a client that speaks first is never
heard; wait on standard input alone and a server that greets you is never printed. Polling
both with `isDone` spins a core to avoid parking.

`packages/platform` grew `waitAny`, and standard input became handle 0, so both sides are
the same primitive — two `recv` calls in flight and a park on whichever answers:

```wac
Pending<u8[]> fromPeer = cli.recv(peer.handle);
Pending<u8[]> fromUser = cli.recv(0);
i32 which = core.waitAny(i32[](fromPeer.id, fromUser.id), -1);
```

The test makes the peer greet *before* reading, so a relay that serviced standard input
first would hang and one that serviced the socket first would never send. Only watching
both passes.

## The five that are not filters

```sh
box serve -8080                          # the built-in routes
box httpd -8080 ./public                 # a directory, over HTTP
box get example.com /                    # an HTTP client
box wget example.com /a.txt out.txt      # ...into a file
box gets host / ca.der                   # ...over TLS 1.3
```

`gets` is **TLS 1.3, in wac, over a raw socket**. `packages/tls` needed no changes:
`tlsClientInit` and `tlsClientFeed` are a state machine over byte arrays, exactly like
`packages/server`'s, and a state machine is what a socket wants. The applet is the driver
and the record framing, and nothing else.

Two things to know before reaching for it. It trusts **the one certificate it is handed**,
because `packages/tls` takes a trust store rather than a flag to skip verification, and
shipping a copy of Mozilla's list is a different job — so this is a demonstration, not a
`curl`. And the ephemeral keys come from `randomBytes`, so the world's one unprivileged
source of entropy is what the handshake's secrecy rests on.

The test runs it against Deno's own TLS server, and checks that a root which did *not*
sign the certificate is refused with no body produced at all.

`httpd` is the first applet that composes the **network and the filesystem**: accept,
parse with `packages/http`, map the path to a file, answer. Its path check is the part to
read — a request target is the one input here that is *supposed* to be hostile, so `..` is
refused outright rather than resolved, because resolving is where traversal bugs live.

`wget` is `get` with three lines changed: `openOutput` moves where `cli.write` goes, so
the fetch itself is unchanged and does not know it is writing to a file. `split` is the
only applet that opens more than one output — everything else opens a file, writes it and
closes it.

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

## tar and diff

```sh
box tar dir | box gzip > x.tgz     # GNU tar can read it
box diff old new                   # unified, byte-identical to diff -u
```

`tar` is the widest applet here — `readDir` and `stat` to walk a tree, `readFile` per
entry, `write` to stream it out. It writes **ustar**, and the test extracts with GNU
`tar` and compares the trees, rather than round-tripping with its own reader: a checksum
that is wrong in a self-consistent way would pass the round trip and fail the real
extractor. It does not do symlinks, permissions, ownership, or names over 100 bytes, and
refuses each rather than truncating.

`diff` is the only applet that is an algorithm rather than plumbing. Longest common
subsequence, hunks with three lines of context, and the same exit status as the real one
— 0 same, 1 different, 2 trouble. The LCS table is O(n·m) in *memory* as well as time, so
it refuses a pair over 4000 lines rather than dying on it; Myers is what a real diff
wants. Fourteen shapes are compared byte for byte against `diff -u`.

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
| **Streams** | cat wc hex crc32 sha256sum sha512sum tr strings gzip gunzip head tail nl rev uniq grep cut fold cp split sponge | bounded by a chunk, a line, or a flag |
| **Cannot** | sort tac | need every line before emitting the first |
| **Cannot** | tee | two sinks at once, and the world has one current output |
| **Could, given an API** | base64 base32 | `codec` encodes a whole array, including the padding, so a chunk cannot be encoded on its own |
| **Could, given an API** | zstd unzstd | `packages/zstd` has no streaming form — a package limit, not the world's, and the only row left |
| **Not worth it** | urlencode urldecode basename dirname date echo seq json stat uuid shuf paste tar diff get wget serve httpd | the input is a line, or the job needs all of it anyway |

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
