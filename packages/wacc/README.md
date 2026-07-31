# wacc — a wac compiler, in wac

Porting the wac compiler to wac, so it can eventually compile itself. The
TypeScript compiler in `~/bare-repos/wac.git` is the reference at every stage: same
input, compare outputs, no judgement calls about correctness.

The point is not the compiler. It is that a compiler is precisely the program shape
wac is worst at — ASTs want sum types, symbol tables want generics, everything
wants strings — so this exercises the top four entries in
`~/notes/living/wac/language-friction-log.md` with a real consumer instead of by
inference.

## Ladder

Each rung is independently verifiable against the TS implementation, so none of
them depends on the next being designed yet.

| rung | reference | oracle | TS lines |
|---|---|---|---:|
| 1. lexer | `wacLex.ts` | token streams match | 279 |
| 2. parser | `wacParse.ts` | ASTs match under a canonical serialization | 1003 |
| 3. type checker | `wacTypeCheck.ts` | diagnostics match, including positions | 1884 |
| 4. emitter | `wacEmitFunc.ts` + `wasmBuildBin.ts` | **wasm bytes identical** | 3599 |
| 5. bootstrap | itself | fixpoint: self-compiled output identical | — |

Corpus for every rung: every `.wac` file in wac-mono and `wac/spec/tour.wac`, plus
generated edge cases.

## Two things the language forces, found before writing any code

**Tokens cannot carry their text.** The TS `Token` has `text: string`. In wac there
is no way to build a `string` from bytes, so a token holds `start` and `len` byte
offsets into the source instead. This is how real compilers do it anyway — it is
cheaper — so the workaround is an improvement, not a wound. It does mean every
consumer compares byte ranges rather than strings.

The sharp edge is **string literals**: the TS lexer stores the *unescaped value*
(`"a\nb"` becomes three characters), which a byte range cannot represent. So a
string token keeps the raw span including quotes and escapes, and unescaping moves
to whoever needs the value. The differential test unescapes the span host-side and
compares against the TS token's text.

**Column numbers mean different things.** The TS lexer indexes by UTF-16 code unit;
a wac lexer walks UTF-8 bytes. Any line containing non-ASCII — which includes most
comments in this repo — gets different column numbers, and diagnostics are compared
by position at rung 3. Options are to count code points in the wac lexer (matches
TS except for astral characters, which TS counts as two) or to declare byte columns
correct and adjust the reference. Deferred until rung 1 measures how often it
actually differs.

**Token kinds have to be functions.** No module-level constants, so ~80 token kinds
become ~80 zero-argument functions. Mechanical, but it is the clearest measurement
yet of that gap: an enum of 80 variants costs 80 function declarations, and the
numbering has to be kept in sync with the harness by hand.

## Status

**Rung 1 (lexer) passes.** Token for token, position for position, against the
reference on 24 `.wac` files plus 31 adversarial cases the corpus cannot cover
(unterminated everything, every escape, greedy operator runs, non-ASCII columns).

Next: rung 2, the parser.

## What rung 1 cost, in language terms

Worth recording precisely, since measuring this is the point.

**83 token kinds became 83 zero-argument functions** (`kinds.wac`, 264 lines) with
no module-level constants. The numbering has to match the reference's union order,
so the test derives that order from `wacLex.ts` at run time rather than trusting a
copy — a hand-synced enum would drift silently.

**Tokens are flat `i32` quintuples, not a `Token[]`.** A growable array of structs
means writing a container by hand, and gzip and json have already each written one.
Flattening also removed growth entirely: a source of n bytes yields at most n
tokens, so the array is sized once.

**Keyword matching packs bytes into an `i64`.** Indexing a `string` yields a
one-character string rather than a byte, so `src[i] == want[i]` does not typecheck.
`string.toBytes` landed mid-write and makes the direct version possible, but it
allocates per candidate and this runs once per identifier.

**No closures**, so the reference's captured `pos`/`line`/`col` become a `Lexer`
struct threaded through every helper. Mechanical, and arguably clearer.

**One compiler bug found and fixed** (`wac` 13e83cc): casting a packed array element
to a wider type emitted no widening at all — `bytes[0] as i64` was invalid wasm for
every packed type. Found because packing bytes into an i64 is the natural way to
compare keywords.

The two design worries from before writing any code both turned out fine. Byte
spans are a better token representation than strings anyway, and counting columns in
UTF-16 code units inside `advance` reproduces the reference's positions exactly — so
the non-ASCII divergence I expected to have to negotiate at rung 3 simply is not
there.
