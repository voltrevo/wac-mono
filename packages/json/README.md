# json

JSON (RFC 8259) parsing and serialization, written in wac.

```sh
deno task test                                            # from the repo root
deno run --allow-read tools/check.ts packages/json/src/json.wac
```

## Status

| Piece | State |
|---|---|
| Parser: objects, arrays, strings, numbers, literals | done |
| String escapes, including `\uXXXX` and surrogate pairs | done |
| Rejection of malformed input | agrees with `JSON.parse` on 5744/5744 mutations |
| Conformance | JSONTestSuite: 95/95 accepted, 188/188 rejected |
| UTF-8 validity | enforced; agrees with a strict `TextDecoder` |
| Decimal → f64 | correctly rounded, bit-exact against `Number(s)` |
| Serializer | done, numbers emitted verbatim |
| Object key lookup | linear scan, then a hash index once it pays — see below |
| Serializing a hand-built tree | done, via `packages/fmt` |

Correctness is judged against the host's own `JSON.parse`/`JSON.stringify` rather
than against hand-written expectations: round-trips are compared to
`JSON.stringify(JSON.parse(x))`, number conversion to `Number(x)` bit-for-bit,
and accept/reject decisions to whether `JSON.parse` throws.

## Bytes inside, strings at the edge

The parser works in `u8[]` UTF-8. That began as a necessity — nothing could build
a `string` from bytes — and it stays because it is right for a scanner: scanning is
a `switch` over `i32` spelled with character literals (`case '{':`), and a
document's strings accumulate in a growable buffer rather than allocating a
`string` per token.

What changed is the boundary. `JsonString.str()`, `JsonMember.keyStr()` and
`JsonObject.getStr("key")` mean calling code never has to see a `u8[]`:

```wac
JsonObject o = ...;
JsonValue? name = o.getStr("name");
match (name!) {
  case Str(bytes): return string.fromBytes(bytes);
  else: trap;
}
```

`getStr` converts the key once, outside the lookup — `toBytes()` allocates, so
converting per member would have turned a scan into an allocation per member.

## Object key lookup

`get` scans the member list, and switches to a hash index once an object has served
16 lookups and has at least 16 members. Both numbers come from
`deno task bench:json-lookup`, which measures three things: what a scan costs per
lookup, what an indexed lookup costs, and what the index costs to build.

That third column is the one that decides the design:

| members | scan/lookup | indexed/lookup | index build | break-even |
|---:|---:|---:|---:|---|
| 16 | 19 ns | 17 ns | 257 ns | 122 lookups |
| 32 | 36 ns | 18 ns | 529 ns | 29 lookups |
| 64 | 83 ns | 16 ns | 1000 ns | 16 lookups |
| 256 | 280 ns | 18 ns | 3784 ns | 15 lookups |
| 1024 | 1460 ns | 27 ns | 23494 ns | 17 lookups |

An index is O(n) hashes before it answers anything, so it takes 15-35 lookups of the
*same object* to repay itself, at every size where it wins at all. Parse a document
and read three fields and it never pays — which is most JSON use.

So the index is built lazily and only on evidence that this object is being read
repeatedly. Two earlier designs were wrong and the benchmark said so:

- **Indexing in `push`**, the obvious version, cost **50% of parse throughput on
  objects with long keys and 68% on nested empty objects**. The second number is the
  instructive one: `Map.create` allocates an eight-slot table, so every `{}` in a
  document paid for a table nothing would ever query. A parser creates far more
  objects than anything looks up.
- **Indexing on size alone**, lazily, fixed the parse cost but still lost on the
  common shape — a 100-member object read twice does 100 hashes to save one scan.

`get` therefore takes `this`, not `const this`: it may build the index. Deep const
makes "logically const, physically memoising" unspellable, since a `const this`
method cannot write a field even when the write is invisible from outside. The same
rule pushed `packages/bignum` from methods to free functions.

Duplicate keys stay correct throughout. JSON permits them, member order is
observable, and `canonicalize` is byte-exact — so the index maps a key to its
*first* member and the list keeps every one. A `Map<u8[], JsonValue>` on its own
would silently collapse `{"a":1,"a":2}` to one member.

## Numbers

Conversion is **correctly rounded**: the double nearest the decimal, ties to even,
for every input. `packages/fmt`'s `atofSpan` does it — a provably exact fast path
for short decimals, and exact bignum arithmetic for everything else, with the
double found by bisecting the bit pattern rather than estimated.

It was not always. Accumulating digits into an `i64` and scaling in `f64` was exact
for 72% of random decimals and up to 2 ulp out otherwise; the table below is what
that used to look like and is kept only to say what changed.

| error | share, before |
|---|---|
| exact | 72.0% |
| 1 ulp | 27.6% |
| 2 ulp | 0.4% |

The serializer writes a parsed number from the source span retained on
`JsonNumber`, so a round-trip is byte-exact: `1e2` comes back as `1e2`, `1.50`
keeps its trailing zero, and `-0` keeps its sign — none of which survives a trip
through the shortest decimal.

A number with no span — `JsonNumber.ofValue(x)`, a tree built by hand — is
formatted by `packages/fmt` to its shortest round-tripping form instead.

## Deliberate divergences from `JSON.parse`

Both are cases where this implementation preserves information JavaScript
discards, and both are covered by tests.

- **Negative zero keeps its sign.** `-0` round-trips as `-0`; JS prints `0`.
- **Duplicate keys are all retained.** `{"a":1,"a":2}` round-trips unchanged; JS
  collapses to `{"a":2}`. RFC 8259 leaves the behaviour undefined, and a tree
  that drops members cannot round-trip its input.

Unpaired surrogate escapes become U+FFFD, because a lone surrogate has no UTF-8
encoding. `JSON.parse` yields a lone surrogate in a UTF-16 string instead.

Malformed UTF-8 in a string is rejected, per RFC 8259 §8.1 — including overlong
forms, CESU-8 surrogates and anything above U+10FFFF. That is stricter than
JSONTestSuite requires, which classifies those documents as implementation-defined.

## Tests

**Host-side (`test/*.test.ts`)** hold the conformance work, because the oracle is
the host's own JSON and cannot exist inside wasm.

`test/jsontestsuite/` is the vendored [JSONTestSuite](https://github.com/nst/JSONTestSuite)
corpus, 318 documents with the expected answer in the filename. It passes whole.

It is worth knowing what it does *not* cover, because it passed on the first run
while the parser accepted every malformed UTF-8 sequence there is. Its
invalid-UTF-8 documents are rejected for structural reasons — `[\xff]` fails
because 0xFF cannot begin a value — and the cases that would test string content
are classified `i_`, where either answer conforms. `test/utf8.test.ts` covers that
gap separately, against a strict `TextDecoder`.

**wac-written (`test/wac/json_test.wac`)** cover internals and the parsed tree.
Host tests can only observe bytes — a `JsonValue` is a GC reference and bindgen
marshals only primitives — so everything they check about the tree is really a
check on its re-serialization, and a bug that cancelled itself out between parse
and stringify would pass. These reach kinds, member ordering, decoded string
contents and container growth where they live.

## Speed

`deno task bench:json` measures by document shape rather than as one
number, because an aggregate hides everything: a parser can be fast on structure
and slow on numbers and still look reasonable.

| shape | MB/s |
|---|---:|
| strings with escapes | 132 |
| long ASCII strings | 109 |
| structure only | 42 |
| multi-byte UTF-8 strings | 96 |
| objects, long keys | 88 |
| realistic mixed | 80 |
| simple decimals | 76 |
| small integers | 64 |
| objects, short keys | 40 |
| long-mantissa numbers | 21 |
| exponent-form numbers | 9 |

Numbers used to be the whole story — 19 MB/s for small integers, 0.5 for
exponent-form — and the fixes were in `packages/fmt`; see its README.

What remains is per-node allocation, and porting `JsonValue` to an enum added one:
a variant carrying a container is a struct wrapping a struct, where the old
`JsonArray : JsonValue` subtype was a single object. The cost is one allocation per
array or object and it scales with container density — structure-only documents went
98 → 40 MB/s, realistic ones 82 → 80. Worth it for exhaustiveness, but worth knowing.

It is not avoidable within the enum: variants cannot carry methods, so the growable
part has to be a separate struct, and mutating a payload in place is blocked because
a matched subject is `const` within its arm.

The same effect is why `std`'s `Vec` is not used here — one more object in the chain,
measured at 16-20% on these shapes. See point 3 under "What this exercised in the
language".

A note on measuring any of this: the box is shared with other agents, and a single
`bench:json` run varies by up to 40% on the object shapes. The numbers above and the
Vec comparison are best-of-nine, and a difference under about 5% on this hardware
should not be believed without that.

## Layout

```
src/value.wac      the JSON value tree
src/parse.wac      scanner and recursive-descent parser
src/stringify.wac  serializer
src/json.wac       entry points shaped for the bindgen boundary
test/              host-side differential tests
test/wac/          unit tests written in wac, via the wactest package
bench/throughput.ts   MB/s by document shape
bench/lookup.ts       scan vs hash index, and what the index costs to build
```

A `JsonValue` tree crosses the boundary directly: structs and enums bind as
classes, so `parse` hands back the tree and a JS caller walks it with `tag` and
the container methods — see `test/tree.test.ts`.

That was not always true. `json.wac` used to return bytes with a status byte in
front, because an export returns one value and nothing but primitives crossed.
The shape was a trap as well as a nuisance: `canonicalize` returned `u8[]`
whether it succeeded or failed, so calling it from *wac* — where the convention
does not apply — put a NUL at the front of the output and made a failure
indistinguishable from success. `packages/server` did exactly that. The result is
a struct now, with an `ok` field, and `errorCode`/`errorPos` are gone: they were
separate exports that re-parsed the input to answer, and a struct carries all
three.

## What this exercised in the language

Full detail, ranked, in `~/notes/living/wac/language-friction-log.md`. In order of
how much each cost:

1. **No float → string — fixed.** `packages/fmt` implements Burger & Dybvig, and
   the one language addition it needed was `f64.toBits`: a program that cannot see
   a float's representation cannot decompose it. A hand-built tree now serializes.
2. **No bytes → string — fixed.** `string.fromCodepoint`, `string.fromBytes` and
   `string.toBytes` were all added because of this package. The last of them
   deleted a 40-line ASCII lookup table from the tests that existed purely because
   nothing converted text to bytes.
3. **No generics — fixed, and it did not help here.** wac has generics now, and
   `std` has `Vec<T>`. Swapping `JsonObject`'s member list to `Vec<JsonMember>`
   cost **16-20% of throughput** on object- and container-heavy documents, because
   a reusable container has to be its own object: every JSON object paid an extra
   allocation, and every member access an extra hop, where the array had sat
   directly in the struct. An inline array measured within 2% of baseline on every
   shape. So both growable cases here are still hand-written, and the duplication
   between them is the price of that 16-20%.

   `Map` is the opposite verdict and is used — see the lookup section. The
   difference is that a map has nothing to inline, and its alternative was O(n).

   Worth being blunt about, since "no generics" was this repo's top-ranked language
   gap for months and *this file* was the example most often cited. The gap was
   real; the fix pays for code reuse, not for speed, and the container it was argued
   from is the one that wants to stay hand-written.
4. **No module-level constants.** Kind tags are zero-argument functions; the
   powers-of-ten table is a `switch` returning literals.
5. **No sum types — fixed.** `JsonValue` is now an `enum` and every fold is a
   `match`, so a forgotten case is a compile error rather than a runtime `trap`. It
   replaced a base struct, an `i32 kind`, six tag constants, a `switch` and an `as!`
   per arm.
6. **Unchecked integer overflow caused a real bug** — 19 digits could exceed
   `i64`, it wraps silently, and only the randomized number sweep caught it. The
   code that overflowed is gone now: conversion moved to `packages/fmt`, which
   never accumulates into a fixed-width integer.

Four compiler defects came out of writing this, all since fixed upstream:

- **`\\` in a string literal lost the character after it** — escapes were decoded
  twice, once by the lexer and again by the emitter. It is why this package's wac
  tests used to spell three inputs out as byte arrays; they read normally now.
- **`export const struct` did not parse.**
- **Character literals** were in the grammar but rejected by the lexer. Now
  implemented, and this package's scanner is written with them.
- **A bare `string` in an expression parsed as the literal `"string"`**, found
  while adding `string.fromCodepoint`.

## Coverage

`deno task coverage:json` reports branch coverage, driven by `cov.ts` in this
package. Currently 100% — all four source files.

Coverage needs an exercise, and an exercise only measures the code it drives, so each
package supplies its own; `harness/wacCoverage.ts` is the shared half. The repo-level
`deno task coverage` covers gzip only, which is [issues/0002](../../issues/open/0002-coverage-and-mutate-only-see-gzip.md).

The hazard to know about: `cov.ts` is a second workload written by hand, so it drifts
from the test suite it is meant to measure. Twice now it has reported a branch as
uncovered that the tests do cover, and once the reverse. When it disagrees with the
suite, the suite is right and `cov.ts` needs the input adding.
