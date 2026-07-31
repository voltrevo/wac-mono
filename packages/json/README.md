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
| Object key lookup | O(n) linear scan |
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
string s = (name! as! JsonString).str();
```

`getStr` converts the key once, outside the scan — `toBytes()` allocates, so
converting per member would turn an O(n) lookup into an O(n)-allocation lookup.

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

## Layout

```
src/value.wac      the JSON value tree
src/parse.wac      scanner and recursive-descent parser
src/stringify.wac  serializer
src/json.wac       entry points shaped for the bindgen boundary
test/              host-side differential tests
test/wac/          unit tests written in wac, via the wactest package
```

Results cross the bindgen boundary as bytes with a status byte in front. Only
primitives and primitive arrays marshal, so a `JsonValue` tree cannot be returned
directly, and with no module-level globals there is nowhere to leave an error code
for a second call to collect.

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
3. **No generics.** `JsonArray.items` and `JsonObject.members` are the same
   double-when-full logic twice, differing only in element type. The byte buffer
   was a third copy and `gzip`'s was a fourth; those two are now one shared
   `packages/bytes`, which is as far as the deduplication can go without generics
   — the two ref-element containers still cannot be shared with it or each other.
4. **No module-level constants.** Kind tags are zero-argument functions; the
   powers-of-ten table is a `switch` returning literals.
5. **No sum types or pattern matching**, and no virtual dispatch, so a tag plus
   `switch` plus a downcast is the shape of every fold over the tree.
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
