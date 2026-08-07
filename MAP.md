# The map

Every package, what it is, and every program you can build. **Generated — do not edit.**
Run `deno task map` after adding a package or an entry point; `deno task map -- --check`
runs in the suite, so a stale map is a failing test rather than a document nobody trusts.

33 packages, 66,841 lines of wac, 1365 tests,
40 command-line programs and 4 browser pages.

## Packages

In dependency order: nothing here imports anything below it.

| package | what it is | wac lines | tests | builds on |
|---|---|---|---|---|
| [`bytes`](packages/bytes/) | `Buf` — a growable byte buffer. | 256 | 25 | — |
| [`regex`](packages/regex/) | A backtracking regular expression engine, with JavaScript's semantics. | 971 | 16 | — |
| [`std`](packages/std/) | Containers and the two sum types every program ends up wanting. | 586 | 42 | — |
| [`unicode`](packages/unicode/) | UTF-8 as code points, and simple case mapping. | 216 | 11 | — |
| [`bignum`](packages/bignum/) | Arbitrary-precision integers. | 629 | 42 | `bytes` |
| [`codec`](packages/codec/) | Base16, base32 and base64, from RFC 4648. | 349 | 10 | `bytes` |
| [`datetime`](packages/datetime/) | The proleptic Gregorian calendar, and RFC 3339 timestamps. | 272 | 14 | `bytes` |
| [`fmt`](packages/fmt/) | Numbers to and from text. | 1,199 | 27 | `bytes` |
| [`gzip`](packages/gzip/) | gzip (RFC 1952) and DEFLATE (RFC 1951) written in wac. | 1,985 | 83 | `bytes` |
| [`platform`](packages/platform/) | A capability world for wac applications, so a program can be written **entirely in wac** — no TypeScript of its own — and still read files, tell… | 3,316 | 114 | `bytes` |
| [`stream`](packages/stream/) | Run a wac transform as a `ReadableStream`/`WritableStream` pair, so it consumes input as it arrives instead of taking the whole thing at once. | 97 | 14 | `bytes` `unicode` |
| [`url`](packages/url/) | A WHATWG URL parser: parse, serialize, and resolve a reference against a base. | 1,219 | 27 | `bytes` `std` |
| [`wacc`](packages/wacc/) | Porting the wac compiler to wac, so it can eventually compile itself. | 3,808 | 14 | `bytes` |
| [`zstd`](packages/zstd/) | Zstandard (RFC 8878) in wac. | 2,686 | 42 | `bytes` |
| [`abi`](packages/abi/) | The contract ABI, in wac: how a call's arguments become calldata and how returned bytes become values. | 560 | 6 | `fmt` |
| [`crypto`](packages/crypto/) | SHA-256, SHA-512/384, SHA-3, SHAKE, keccak256, HMAC, HKDF, bcrypt_pbkdf, ChaCha20-Poly1305, AES-CTR, AES-GCM, X25519, Ed25519, NIST P-256 and… | 5,724 | 149 | `bignum` |
| [`fs`](packages/fs/) | A filesystem that belongs to the system rather than to the host. | 594 | 12 | `bytes` `platform` `std` |
| [`http`](packages/http/) | HTTP/1.1: parsing requests and responses, and writing both. | 1,023 | 29 | `bytes` `fmt` `platform` |
| [`json`](packages/json/) | JSON (RFC 8259) parsing and serialization, written in wac. | 955 | 51 | `bytes` `fmt` `std` |
| [`rlp`](packages/rlp/) | Recursive Length Prefix — the Ethereum execution layer's serialisation, in wac. | 317 | 8 | `fmt` |
| [`wactest`](packages/wactest/) | Assertions for tests written in wac. | 222 | 16 | `fmt` |
| [`bls`](packages/bls/) | BLS signature verification on BLS12-381 — the Ethereum parameters and encodings. | 4,049 | 45 | `crypto` |
| [`ethrpc`](packages/ethrpc/) | Asking an Ethereum node a question, so the packages that *verify* answers have something to verify. | 126 | 1 | `fmt` `http` `json` `platform` |
| [`mpt`](packages/mpt/) | Merkle-Patricia proofs, verified — the piece that turns "a provider told me" into "the state root I already verified commits to this". | 489 | 27 | `codec` `crypto` `fmt` `rlp` `std` |
| [`server`](packages/server/) | An HTTP server written in wac. | 333 | 20 | `bytes` `codec` `datetime` `http` `json` `regex` `url` |
| [`sh`](packages/sh/) | A shell, in wac. | 6,564 | 31 | `bytes` `fmt` `fs` `platform` `std` |
| [`ssz`](packages/ssz/) | **Everything an Altair light client needs is done and checked against Ethereum's vectors. | 808 | 26 | `crypto` |
| [`tls`](packages/tls/) | TLS 1.3 (RFC 8446) in wac. | 3,696 | 78 | `crypto` |
| [`box`](packages/box/) | 60 applets in one program, chosen by the first argument. | 3,965 | 33 | `bytes` `codec` `crypto` `datetime` `fmt` `gzip` `http` `json` `platform` `regex` `server` `sh` `std` `tls` `unicode` `url` `zstd` |
| [`ens`](packages/ens/) | The name a person types, turned into the node a contract is asked about. | 361 | 13 | `crypto` `mpt` |
| [`lightclient`](packages/lightclient/) | **The Altair sync protocol works. | 642 | 12 | `bls` `ssz` |
| [`ssh`](packages/ssh/) | An SSH-2 client and server, in wac, **and `ssh` and `sshd` programs built from them. | 3,551 | 46 | `bytes` `codec` `crypto` `fmt` `platform` `sh` |
| [`tor`](packages/tor/) | Tor in wac, both ends: a client and SOCKS5 proxy, a relay, a directory authority, an onion-service client, and a test network with no C tor in it. | 15,273 | 281 | `bytes` `codec` `crypto` `datetime` `fmt` `http` `platform` `std` `tls` `wactest` |

## Programs

Every `export i32 main` in the tree. Build one with:

```sh
deno task app:build <path> --allow-read -o name && ./name
```

Grants are chosen at build time and the shebang of the result states exactly what it may
reach — see `packages/platform/README.md`.

| program | what it does |
|---|---|
| `packages/platform/example/crowd.wac` | How many host calls a program may have in flight, measured rather than quoted. |
| `packages/platform/example/greet.wac` | Listen, take one connection, and say who it came from. |
| `packages/platform/example/hexdump.wac` | A filter: bytes in, bytes out. `hexdump < file` or `hexdump file`. |
| `packages/platform/example/inetd.wac` | A network service whose handler is another wac program. |
| `packages/platform/example/inside.wac` | Running a program inside another one, with a world of its own. |
| `packages/platform/example/overlap.wac` | Two reads in flight at once — what the ticket surface is actually for. |
| `packages/platform/example/patience.wac` | Bounding how long a call may take. |
| `packages/platform/example/pipe.wac` | Two programs, piped together, with no shell involved. |
| `packages/platform/example/probe.wac` | A program that reports what it is allowed to do, for testing what a child is granted. |
| `packages/platform/example/roundtrip.wac` | The filesystem, wherever it happens to be. |
| `packages/platform/example/runner.wac` | Run another wac program as a worker, feed it, and read what it says. |
| `packages/platform/example/twin.wac` | A program that runs itself. |
| `packages/platform/example/waiter.wac` | A program that does not end by itself. |
| `packages/platform/example/wc.wac` | A word-count application, entire. There is no TypeScript in this directory. |
| `packages/platform/example/whichever.wac` | Wait on two sockets and report whichever speaks first. |
| `packages/platform/example/writeread.wac` | Can a socket be written to while a read on it is still outstanding? |
| `packages/fs/example/ops.wac` | The same filesystem operations against memory or against the host, so the two can be compared. |
| `packages/ethrpc/example/blocknumber.wac` | The smallest thing that asks a node a question: `eth_blockNumber`, printed. |
| `packages/sh/src/sealed.wac` | A shell whose filesystem is its own: nothing it writes touches the host. |
| `packages/sh/src/sh.wac` | `sh` — the shell as a program, entire, in wac. |
| `packages/box/example/term.wac` | A shell, in a browser tab. |
| `packages/box/src/bin/cp.wac` | `cp` on its own: the same applet, built as its own program. |
| `packages/box/src/bin/grep.wac` | `grep` on its own: the same applet, built as its own program. |
| `packages/box/src/bin/sh.wac` | The shell, with every applet in this package as a command. |
| `packages/box/src/bin/sha256sum.wac` | `sha256sum` on its own: the same applet, built as its own program. |
| `packages/box/src/bin/wc.wac` | `wc` on its own: the same applet, built as its own program. |
| `packages/box/src/box.wac` | A busybox-shaped application: one program, many applets, chosen by the first argument. |
| `packages/ssh/src/ssh.wac` | `ssh` — the client as a program, entire. There is no TypeScript in this package's `src/`. |
| `packages/ssh/src/sshd.wac` | `sshd` — an SSH server, entire, in wac. |
| `packages/tor/src/app.wac` | A Tor client, entire. |
| `packages/tor/src/dird.wac` | A directory authority's HTTP port: serve the consensus, the certificate and the descriptor. |
| `packages/tor/src/gendesc.wac` | Generate a router descriptor and write it to a file, so tor's own parser can judge it. |
| `packages/tor/src/genhsdesc.wac` | Write an onion service descriptor to a file, so tor's own decoder can judge it. |
| `packages/tor/src/genintro.wac` | Write an ESTABLISH_INTRO cell to a file, so tor's own parser can judge it. |
| `packages/tor/src/hsconnect.wac` | Connect to a v3 onion service and fetch a page from it. |
| `packages/tor/src/hsfetch.wac` | Fetch a v3 onion service's descriptor from the network, and say what is in it. |
| `packages/tor/src/hsserviced.wac` | Host a v3 onion service. |
| `packages/tor/src/network.wac` | Stand up a Tor network from a description, run something across it, and take it down. |
| `packages/tor/src/relayd.wac` | A Tor relay: accept a connection, prove who we are, and carry circuits. |
| `packages/tor/src/socks.wac` | A SOCKS5 proxy that carries streams over Tor. |

## Pages

Every `export i32 page`: an interactive browser application, built with `--target browser`
and served with the two cross-origin isolation headers that `SharedArrayBuffer` needs.

```sh
deno task app:build <path> --target browser -o page/index.html
box httpd -8080 page -x
```

| page | what it does |
|---|---|
| `packages/platform/example/counter.wac` | An interactive page: draw something, then answer what the user does. |
| `packages/platform/example/pixels.wac` | Pixels, a pointer, and a frame you can keep. |
| `packages/box/example/hash.wac` | A page that hashes and compresses what you type, as you type it. |
| `packages/box/example/term.wac` | A shell, in a browser tab. |
