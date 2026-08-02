# wactest

Assertions for tests written in wac.

```wac
import { T } from "../../../wactest/src/assert.wac";
import { crc32 } from "../../src/crc32.wac";

export string test_crc32_of_hello_world() {
  T t = T.create();
  u8[] data = u8[](104, 101, 108, 108, 111);
  t.eqI32(crc32(data), 907060870, "crc32(\"hello\")");
  return t.report();
}
```

Run it by registering the file from a `.test.ts`:

```ts
import { wacTestRun } from "../../../harness/wacTestRun.ts";
await wacTestRun("packages/gzip/test/wac/huffman_test.wac", "huffman");
```

## The shape, and why

**A test is an exported function returning `string`** — empty means pass. That
makes discovery free: `wacCompile` returns export *names*, so a runner can call
every no-argument `test*` export returning `string`. No annotations, no
registration, no language feature.

**Assertions record rather than trap.** `trap` carries no message, so a trapping
assertion would tell you only that something failed. Recording also means one run
reports every failure instead of stopping at the first.

**Failures accumulate in a `T` the test owns.** wac has no top-level mutable
state, so there is nowhere global to put them; the test creates a `T` and returns
`t.report()`.

## Assertions

| | |
|---|---|
| `eqI32(got, want, what)` | equality, message names both values |
| `neI32(got, unwanted, what)` | inequality |
| `isTrue(cond, what)` / `isFalse` | boolean |
| `eqStr(got, want, what)` | string equality |
| `eqI32Array(got, want, what)` | length then first differing element |
| `eqBytes(got, want, what)` | same for `u8[]`, compared zero-extended |
| `failNow(what)` | unconditional — for a branch that should be unreachable |

`itoa` is exported separately for building messages of your own. It exists
because `string + i32` is deliberately a compile error in wac and there is no
built-in number-to-string; it works by indexing `"0123456789"`, since indexing a
string yields a one-character string.

## Tests that need the host

A test may take parameters, and `wacTestRun`'s third argument supplies them
positionally, trimmed to the number each test declares. So one file mixes tests
that need the host with tests that do not, and a test declaring no `fn`
parameter compiles to a module with **no wasm imports at all** — checkable on the
binary rather than promised.

```wac
export string test_sha256(fn[u8[](u8[], i32)] ref) { … }
```
```ts
await wacTestRun(entry, "hash", [ (bytes, bits) => nodeHash(bytes, bits) ]);
```

This is what let `crypto` and `tls` move most of their suites in here. Four
shapes turned up, and they are worth telling apart because they differ in what
the host is trusted for:

| shape | when | example |
|---|---|---|
| nothing | the property is a relation between the code's own outputs | GHASH's field laws; both ends of a key exchange agreeing |
| an **oracle** callback | an independent implementation exists and is synchronous | `node:crypto` for SHA-2, HMAC, AES, Ed25519 |
| host-computed **data** | the oracle is asynchronous, or will not expose what is needed | ML-KEM: WebCrypto is a promise, and only it exports a key's seed |
| a **loader** callback | the inputs live outside wasm | certificate fixtures for path building |

A wrong oracle makes a test wrong. A wrong loader makes it fail on the first
parse. Worth knowing which one you are writing.

**The oracle must be synchronous**, because a wasm call cannot await.
`node:crypto` is synchronous where WebCrypto is not, and
`Deno.Command().outputSync()` covers anything reachable as a subprocess. A worker
plus `Atomics.wait` would make an async one appear synchronous and is
deliberately not used here: it puts something that can deadlock inside the part
of the system whose job is to fail clearly.

**Prefer borrowing the primitive, not the construction.** Checking HKDF against a
host HKDF compares two implementations of the same thing; checking it against
HMAC checks the construction — the counter, the chained block, where the label
sits — against something with no opinion about any of it.

## What this still cannot do

**Assert a refusal.** A rejection in wac is a `trap`, and a trap unwinds the
module rather than returning, so no test here can say "this input must be
refused". Those stay in a host-side `.test.ts` that can catch it. Every file
converted so far split along exactly that line, which turned out to be a good
organisation: what remains in TypeScript is the refusals, and for anything fed by
a network that is the half that matters.

**See a wrong representative.** A value congruent to the right one satisfies
every relation the code can state about itself. `field25519`'s laws, plus anchors
naming the modulus, plus boundary values around p, all pass when the carry is one
pass short of complete — and an outside reference catches it immediately. So a
differential is not always replaceable by properties, and that file keeps both
with each explaining the other.

**Interoperate.** A live peer's next byte depends on ours, which is not something
a vector or an invariant can express. The TLS handshake tests against OpenSSL,
rustls and curl stay where they are.

## Float assertions

`eqF64` compares through `f64.toBits`, not `==`, so NaN equals NaN and `-0.0` is
distinct from `0.0` — the two cases `==` gets wrong for a test's purposes.
`nearF64(got, want, tol)` is the tolerance form, and rejects NaN rather than letting
a false comparison pass it.

Both name the offending value in the failure message, which needs float-to-string
and so depends on [`fmt`](../fmt/). That dependency is why they did not exist
before: an assertion that cannot say what it got is close to useless.

`itoa` used to live here for the same reason and has moved to `fmt`, next to
`ftoa` — same job, other numeric type, and a test library is not the natural home
for number formatting.
