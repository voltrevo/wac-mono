# wac-mono

Programs and libraries written in [wac](https://github.com/voltrevo/wac), a
C-family language for WebAssembly GC. One repo so packages can import each other.

Deliberately separate from the wac repo: that one is the language and its
compiler, this one is things built with it.

## Packages

| package | what it is |
|---|---|
| [`bytes`](packages/bytes/) | `Buf`, the growable byte buffer both other packages build on |
| [`fmt`](packages/fmt/) | `f64` to its shortest decimal, matching JavaScript exactly |
| [`crypto`](packages/crypto/) | SHA-256, SHA-512/384, HMAC, HKDF, ChaCha20-Poly1305, AES-CTR, AES-GCM — checked against WebCrypto, a BigInt reference and the published vectors |
| [`gzip`](packages/gzip/) | gzip and DEFLATE, both directions — compresses at or under `gzip -6` |
| [`json`](packages/json/) | JSON parse and serialize, verified against the host's own JSON |
| [`bignum`](packages/bignum/) | arbitrary-precision integers, semantics identical to `BigInt` |
| [`url`](packages/url/) | WHATWG URL parsing, serialization and relative resolution |
| [`codec`](packages/codec/) | base16, base32 and base64 from RFC 4648, strict on decode |
| [`regex`](packages/regex/) | a backtracking regex engine with JavaScript's semantics |
| [`datetime`](packages/datetime/) | the proleptic Gregorian calendar and RFC 3339 timestamps |
| [`http`](packages/http/) | HTTP/1.1 request parsing, strict about framing |
| [`unicode`](packages/unicode/) | UTF-8 as code points, and simple case mapping |
| [`stream`](packages/stream/) | run a wac transform as a stream, with the host doing the blocking wac cannot |
| [`platform`](packages/platform/) | a capability world, so an application can be written **entirely in wac** — no TypeScript of its own |
| [`zstd`](packages/zstd/) | Zstandard, both directions — 22% smaller than `gzip -6`, within 4% of `zstd -3` |
| [`tls`](packages/tls/) | TLS 1.3 (RFC 8446) — **not for production**, see its README |
| [`ssh`](packages/ssh/) | SSH-2 both ways — `ssh` runs commands on OpenSSH, `sshd` serves OpenSSH's client |
| [`sh`](packages/sh/) | a shell — quoting, expansion, pipelines and redirection, checked against bash |
| [`wacc`](packages/wacc/) | the wac compiler, in wac, so it can eventually compile itself |
| [`server`](packages/server/) | an HTTP server in wac — the packages, composed and running |
| [`std`](packages/std/) | `Vec<T>`, `Map<K, V>`, `Option<T>`, `Result<T, E>` — the containers generics made writable |
| [`wactest`](packages/wactest/) | assertions for writing tests in wac |

## Layout

```
deno.json          import map + tasks; the only config
harness/           TypeScript for driving the compiler
  wacFiles.ts        read an entry file and its transitive imports
  wacBind.ts         compile -> bindgen -> importable JS module
  wacTestRun.ts      run wac-written tests as Deno tests
  wacCoverage.ts     instrument an entry point and report branch coverage
tools/             check.ts, validate.ts, coverage.ts, mutate.ts, mutate/
issues/            bug reports and cross-cutting tasks; see issues/README.md
packages/<name>/
  src/               wac source
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
deno task test            # all tests, host-side and wac-written (parallel: ~30s, vs ~76s serial)
deno task wac:pin         # record the sibling wac checkout as the minimum this repo needs
deno task app <entry.wac> --allow-read -- args   # run a wac application
deno task app:build <entry.wac> --allow-read -o wc   # ...or build one executable; then: ./wc FILE
deno task app:build <entry.wac> --target node -o wc  # ...for Node instead of Deno
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
```

## Keeping the compiler pin current

`deno.json` maps `wac/` to `../wac/atoms/wac/`, so the compiler is whichever sibling
checkout you happen to have. `wac-version.json` records the oldest one this repo is known
to work with, and the harness checks it before compiling anything. A checkout that is
older fails with *"wac-mono needs a newer compiler"* naming the commit and the reason,
instead of a `CompileError` in whichever package used the new feature — which is what
used to happen, four times, to three different agents (`issues/closed/0001`, `0008`).

**Being ahead of the pin is normal and is never an error.** The pin is a floor.

**Bump it when you adopt a compiler feature that did not exist before.** That is the only
time it is required, and the sequence is:

```sh
git -C ../wac pull                              # get the compiler you want
deno task test                                  # prove this repo works with it
deno task wac:pin -- "generic enums, for std"   # then record it, with a real reason
```

The order matters: the pin is a claim that the suite passes against that compiler, and
`wac:pin` cannot check that for you. It refuses a dirty wac working tree and refuses to
move the floor backwards, but it takes your word on the rest.

**Otherwise, bump it when it drifts.** Once the checkout is 40 commits ahead, every run
prints a one-line note suggesting it. That is the whole reminder mechanism — nobody has to
remember, because the suite says so — and acting on it is a green run plus `wac:pin`. A pin
that lags a long way behind is not wrong, but it has stopped saying anything useful about
what this repo needs.

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
