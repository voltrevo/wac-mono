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
| Decimal → f64 | exact on the fast path, ≤2 ulp otherwise |
| Serializer | done, numbers emitted verbatim |
| Object key lookup | O(n) linear scan |
| f64 → shortest decimal | not implemented — see below |

Correctness is judged against the host's own `JSON.parse`/`JSON.stringify` rather
than against hand-written expectations: round-trips are compared to
`JSON.stringify(JSON.parse(x))`, number conversion to `Number(x)` bit-for-bit,
and accept/reject decisions to whether `JSON.parse` throws.

## Everything is bytes

The API takes and returns `u8[]` (UTF-8), not wac's `string`.

`string` is immutable and has `len`, `slice`, `indexOf` and `fromCodepoint`.
`fromCodepoint` can now produce any single character, so the `\uXXXX` decoding
that was once inexpressible is expressible — but only one character at a time,
joined with `+`, which on an immutable string is quadratic. Bytes stay the right
representation until there is a `string.fromBytes`.

They are also the better representation for a scanner: it becomes a `switch` over
`i32` — spelled with character literals, so `case '{':` rather than `case 0x7B:` —
and output accumulates in a growable buffer instead of through `+`.

## Numbers

Significant digits accumulate into an `i64` with a decimal exponent, then a
single scaling step produces the `f64`. This is exact when the mantissa is under
2^53 and the power of ten is within the exactly-representable range (|e| ≤ 22).
Beyond that, the power is decomposed as `10^(22k + r)` so the result costs three
roundings rather than one per factor of `1e22`.

Measured against the host over 3000 random decimals spanning the full exponent
range:

| error | share |
|---|---|
| exact | 72.0% |
| 1 ulp | 27.6% |
| 2 ulp | 0.4% |

Being exact on every input needs 128-bit intermediates (Eisel-Lemire) or a
big-decimal fallback. wac's widest integer is `i64`, so neither is available
without implementing wide arithmetic first.

The serializer writes each number from the source span retained on `JsonNumber`.
That makes round-trips exact and avoids the other half of the problem: wac has no
float-to-string operation of any kind, so printing a *computed* number would mean
implementing shortest-round-trip formatting (Ryu or Grisu) from scratch. A tree
built by hand rather than by parsing cannot currently be serialized.

## Deliberate divergences from `JSON.parse`

Both are cases where this implementation preserves information JavaScript
discards, and both are covered by tests.

- **Negative zero keeps its sign.** `-0` round-trips as `-0`; JS prints `0`.
- **Duplicate keys are all retained.** `{"a":1,"a":2}` round-trips unchanged; JS
  collapses to `{"a":2}`. RFC 8259 leaves the behaviour undefined, and a tree
  that drops members cannot round-trip its input.

Unpaired surrogate escapes become U+FFFD, because a lone surrogate has no UTF-8
encoding. `JSON.parse` yields a lone surrogate in a UTF-16 string instead.

## Tests

**Host-side (`test/*.test.ts`)** hold the conformance work, because the oracle is
the host's own JSON and cannot exist inside wasm.

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

1. **No bytes → string.** Still the blocking one, and the reason this package is
   byte-oriented. `string.fromCodepoint` (added because of this package) covers a
   single character; assembling a string from bytes is still quadratic.
2. **No float → string.** Blocking for any serializer over computed values.
3. **No generics.** `JsonArray.items` and `JsonObject.members` are the same
   double-when-full logic twice, differing only in element type. The byte buffer
   was a third copy and `gzip`'s was a fourth; those two are now one shared
   `packages/bytes`, which is as far as the deduplication can go without generics
   — the two ref-element containers still cannot be shared with it or each other.
4. **No module-level constants.** Kind tags are zero-argument functions; the
   powers-of-ten table is a `switch` returning literals.
5. **No sum types or pattern matching**, and no virtual dispatch, so a tag plus
   `switch` plus a downcast is the shape of every fold over the tree.
6. **Unchecked integer overflow caused a real bug** — 19 digits can exceed `i64`,
   it wraps silently, and only the randomized number sweep caught it.

Four compiler defects came out of writing this, all since fixed upstream:

- **`\\` in a string literal lost the character after it** — escapes were decoded
  twice, once by the lexer and again by the emitter. It is why this package's wac
  tests used to spell three inputs out as byte arrays; they read normally now.
- **`export const struct` did not parse.**
- **Character literals** were in the grammar but rejected by the lexer. Now
  implemented, and this package's scanner is written with them.
- **A bare `string` in an expression parsed as the literal `"string"`**, found
  while adding `string.fromCodepoint`.
