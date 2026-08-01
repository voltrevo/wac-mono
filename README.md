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
deno task test            # all tests, host-side and wac-written
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
deno task coverage:std
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
