# wac-mono

Programs and libraries written in [wac](https://github.com/voltrevo/wac), a
C-family language for WebAssembly GC. One repo so packages can import each other.

Deliberately separate from the wac repo: that one is the language and its
compiler, this one is things built with it.

## The map

**[MAP.md](MAP.md)** is the bird's-eye view: every package with its size, its tests and what
it builds on, and every program and page you can build, each with a line on what it does. It
is generated from the tree by `deno task map` and checked by the suite, so it cannot drift.

Today, give or take whatever landed this morning: **24 packages, ~41,000 lines of wac, ~900
tests, 20 command-line programs and 4 browser pages.** MAP.md has the exact figures, and the
suite checks its *structure* — packages, dependencies, programs — rather than its counts, since
three agents share this repo and a guard that fails on somebody else's new test is a guard
everyone learns to ignore.

## What is actually in here

The libraries are the boring half and the reason the rest exists — `bytes`, `std`, `fmt`,
`unicode`, `codec`, `json`, `url`, `regex`, `datetime`, `http`, `bignum`. Each is checked
against something outside itself: JSON against the host's own parser, `fmt` over 500k doubles
in both directions, `url` against WHATWG's test suite, `bignum` against `BigInt`.

What they add up to is more interesting:

**`box` — a busybox.** Fifty-nine applets in one program, chosen by the first argument, each
differential-tested against the real tool where one exists. `cat`, `grep`, `sort`, `gzip`,
`sha256sum`, `tar`, `diff`, `httpd`, `nc`. It streams: 300MB through `wc` peaks at 94MB of RSS.

```sh
deno task app:build packages/box/src/box.wac --allow-read --allow-write --allow-net -o box
./box tar somedir | ./box gzip > out.tgz     # and GNU tar extracts it
```

**`sh` — a shell**, checked against GNU bash script for script: quoting, expansion, command
substitution, arithmetic, pipelines, redirection, `if`/`while`/`for`/`case`, functions,
subshells, globbing.

**`ssh` — both ends.** `ssh` runs commands on a real OpenSSH server; `sshd` serves OpenSSH's
own client, hosting the shell above. Curve25519, Ed25519, chacha20-poly1305, `known_hosts`,
encrypted private keys.

**`tls` — TLS 1.3**, interoperating with OpenSSL and rustls. **`tor`** is a Tor client on top
of it, with a SOCKS5 proxy. **`crypto`** is what they stand on: SHA-2, SHA-3, HMAC, HKDF,
AES-GCM, ChaCha20-Poly1305, X25519, Ed25519, P-256, P-384, RSA verification, ML-KEM-768 — all
in wac, all against published vectors.

**`gzip` and `zstd`** compress at or under the reference tools. **`wacc`** is the wac compiler
being ported to wac, so it can eventually compile itself.

**`platform` — a capability world**, and the reason a wac program can be an *application*
rather than a library. Two structs say everything a program may do, because wac has no ambient
access and there is nowhere else to reach. Files, sockets, spawning other wac programs with
grants narrower than your own, deadlines, and a browser target.

## In a browser

The same compiled wac runs in a page: a worker for the program, the page's own thread for the
capabilities, and `SharedArrayBuffer` between them.

```sh
deno task app:build packages/box/example/term.wac --target browser --allow-read --allow-write -o page/index.html
./box httpd -8080 page -x        # -x sends the two isolation headers a page needs
```

That one is **`packages/sh` in a browser tab** — pipelines, loops, redirection into a
filesystem that survives a reload — with the shell unchanged. `box/example/hash.wac` hashes and
compresses as you type, with `crypto` and `gzip` unchanged. `platform/example/pixels.wac` is a
Mandelbrot set recomputed on every zoom, with the escape count under the pointer and a dropped
file handed straight back.

## Layout

```
deno.json          import map + tasks; the only config
MAP.md             generated: every package, program and page — `deno task map`
harness/           TypeScript for driving the compiler
  wacFiles.ts        read an entry file and its transitive imports
  wacBind.ts         compile -> bindgen -> importable JS module
  wacTestRun.ts      run wac-written tests as Deno tests
  wacCoverage.ts     instrument an entry point and report branch coverage
tools/             check.ts, validate.ts, coverage.ts, mutate.ts, map.ts, push.sh
design/            directions too big to be issues, one numbered document each; see design/README.md
issues/            bug reports and cross-cutting tasks; see issues/README.md
packages/<name>/
  src/               wac source
  src/bin/           optional: applets built as standalone programs
  example/           optional: runnable programs and browser pages
  test/              host-side tests (.test.ts)
  test/wac/          tests written in wac (*_test.wac)
  cov.ts             optional: drives this package's branch coverage
```

`deno.json` maps `wac/` to a sibling checkout of the compiler
(`../wac/atoms/wac/`), so clone both next to each other.

## Cross-package imports

wac imports are relative file paths, so a package reaches a sibling by path:

```wac
import { T } from "../../../wactest/src/assert.wac";
```

There is no module-alias mechanism in the language, so this is what it looks
like. Keeping the tree at `packages/<name>/src` bounds the depth.

## Commands

Everything runs from the repo root, so one command covers every package.

```sh
deno task test            # all tests, host-side and wac-written (~50s on five cores)
deno task test:changed    # ...only the packages you have touched, for the loop before that
deno task check           # type-check every .ts, including the drivers no test imports (~1s)
deno task wac:pin         # record the sibling wac checkout as the minimum this repo needs
deno task app <entry.wac> --allow-read -- args   # run a wac application
deno task app:build <entry.wac> --allow-read -o wc   # ...or build one executable; then: ./wc FILE
deno task app:build <entry.wac> --target node -o wc  # ...for Node instead of Deno
deno task app:build <entry.wac> --target browser -o page/index.html  # ...or a browser page
deno task app:build <entry.wac> --worker -o child.worker.js  # ...or something `spawn` can run
deno task map             # regenerate MAP.md; the suite fails if it is stale
deno task coverage        # branch coverage of every package, from its wac-native tests
deno task coverage:bignum # ...and the host-driven exercises, per package
deno task coverage:bytes
deno task coverage:codec
deno task coverage:crypto
deno task coverage:datetime
deno task coverage:fmt
deno task coverage:gzip
deno task coverage:http
deno task coverage:json
deno task coverage:regex
deno task coverage:server
deno task coverage:std
deno task coverage:unicode
deno task coverage:url
deno task mutate          # mutation testing, curated defects
deno task mutate:operators # ...plus generated ones (removed guards, gutted functions)
deno task mutate:diff     # ...only for .wac files changed against origin/master
deno task bench           # gzip throughput
deno task bench:json      # json throughput, by document shape
deno task bench:json-lookup # json object lookup: scan vs hash index, and index build cost
deno task verify:fmt      # fmt exactness over 500k doubles, both directions

deno run --allow-read tools/check.ts <entry.wac>    # type-check one file, no run
deno run -A tools/validate.ts <entry.wac>          # ...and check the wasm validates
tools/push.sh             # run the suite, then push only if it passed
```

`deno task test` skips one test: the browser target running in an actual browser, which needs
Chromium installed and `deno test -A`. `packages/platform/test/browser_live.test.ts` says how
in three commands, and skips in milliseconds without them.

### What the suite costs, and where

Measured on five cores: **~50 seconds** for all 910 tests in parallel, about 160 seconds of CPU. One
file at a time in its own process is 6.5 minutes, and most of that is a hundred and forty deno
startups; the heaviest single files are `packages/box` (25s, three hundred subprocesses comparing
applets against the GNU tools) and `packages/regex` (17s, differential fuzzing against `RegExp`).
Nothing hangs and nothing is pathological — it is a lot of tests, most of them differential against
something real.

If a run takes many minutes, the cause is almost certainly *load* rather than the suite: several
agents share this machine, and five cores between three of them turns fifty seconds into whatever
you like. `nproc` and `/proc/loadavg` answer that question before a bisect does.

**Builds are cached by content** in `.cache/`, which is what took the suite's CPU down by a sixth and
`packages/box` from 38 seconds to 26. A wac program compiled with a given compiler, or bundled into an
application with given grants, is produced once and then copied: the key is a SHA-256 over every
reachable `.wac` file, every `.ts` file of the compiler, the harness, `packages/platform`'s host, the
Deno version and the build's arguments — never a timestamp, because `git checkout` of an older file is
a new input with an older mtime. `harness/buildCache.ts` has the reasoning and
`harness/buildCache.test.ts` pins the parts of the key that would be silently wrong if dropped.
Deleting `.cache` is always safe and is the whole of the invalidation story.

## Keeping the compiler pin current

`deno.json` maps `wac/` to `../wac/atoms/wac/`, so the compiler is whichever sibling
checkout you happen to have. `wac-version.json` records the oldest one this repo is known
to work with, and the harness checks it before compiling anything. A checkout that is
older fails with *"wac-mono needs a newer compiler"* naming the commit and the reason,
instead of a `CompileError` in whichever package used the new feature — which is what
used to happen, four times, to three different agents (`issues/closed/0001`, `0008`).

**Being ahead of the pin is normal and is never an error.** The pin is a floor.

**Update it proactively — whenever the suite has just passed and wac has moved.** This
used to say the opposite ("bump it only when you adopt a compiler feature that did not
exist before"), and that rule failed in the way rules like it do: the pin sat at a
2026-08-03 commit while wac went 52 commits ahead, and nothing about the drift told
anyone whether the claim was still true. It was — every package still built against that
commit when somebody eventually tested it — but nobody had, for two days, and the note the
harness prints had become something three agents scrolled past.

A pin that names a compiler the suite passed against *this week* is a useful claim. A pin
that names the oldest commit that happens to still work is an archaeological fact nobody
maintains. The sequence either way:

```sh
git -C ../wac pull                              # get the compiler you want
deno task test                                  # prove this repo works with it
deno task wac:pin -- "generic enums, for std"   # then record it, with a real reason
```

The reason field is read by whoever hits *"wac-mono needs a newer compiler"* weeks later.
Name the feature when a feature is why; say `routine` when it is a routine bump, because
"routine" is honest and a copied commit subject is not.

The order matters: the pin is a claim that the suite passes against that compiler, and
`wac:pin` cannot check that for you. It refuses a dirty wac working tree and refuses to
move the floor backwards, but it takes your word on the rest.

**Otherwise, bump it when it drifts.** Once the checkout is 40 commits ahead, every run
prints a one-line note suggesting it. That is the whole reminder mechanism — nobody has to
remember, because the suite says so — and acting on it is a green run plus `wac:pin`. A pin
that lags a long way behind is not wrong, but it has stopped saying anything useful about
what this repo needs.

## Dependencies: none, and the one exception

Nothing here imports a third-party package. Every test file writes its own `assertEquals`
for that reason, which is why you will see the same eight lines in thirty files, and it is
deliberate: a repo whose only inputs are Deno and the wac compiler pin can be checked out
and run in five years.

`deno.lock` exists for exactly one exception, and names it: `npm:playwright`, imported
*dynamically inside* `packages/platform/test/browser_live.test.ts`, which runs the browser
target in a real browser. That test is ignored unless a browser is installed and the run has
`--allow-sys`, so `deno task test` skips it in milliseconds and fetches nothing. The lockfile
is there to pin the version and its integrity hash rather than resolve whatever is newest at
the moment somebody happens to run it — an unpinned dynamic import would be the worse
position to be in, not the purer one.

No package's own code imports it, and nothing else in the suite needs the network.

## Two kinds of test

**Host-side (`test/*.test.ts`)** for anything needing an external oracle or the
outside world — differential testing against python's zlib, interop with the
system `gunzip`, corpus generation, subprocesses. This is where most of the
confidence in `gzip` comes from and it cannot move into wac.

**wac-written (`test/wac/*_test.wac`)** for unit tests of wac code, especially
internals. A test is an exported function returning `string`: empty means pass,
anything else is the failure report. `wacTestRun` discovers them by enumerating
`test*` exports of the compiled module — no language feature required — and
registers each as a Deno test so both kinds appear in one run.

Writing them in wac removes two frictions. Internals no longer need a probe file
that re-exports them one value at a time just so TypeScript can reach them
(`gzip`'s Huffman tests used to work that way). And values never cross the wasm
boundary, so there is no `i8[]`↔`Uint8Array` marshalling, no `i64`↔`bigint`, and
no worrying about how `-0.0` or NaN survive the trip.
