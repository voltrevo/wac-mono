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

**Tokens should not carry their text** — though as of `ea22a8f`/`35e938c` they
now *could*. The TS `Token` has `text: string`, and when this was written nothing
in wac could build a `string` from bytes; `string.fromBytes` and `string.toBytes`
now exist, so the constraint is gone.

The decision stands anyway, on its own merits rather than as a workaround: a token
holds `start` and `len` byte offsets into the source, which is how real compilers
do it because it is cheaper than a string per token. Consumers compare byte ranges.
What has changed is that this is now a choice, and a token that genuinely wants its
text can have it.

The **string literal** case is the one the new builtins actually change. The TS
lexer stores the *unescaped value* (`"a\nb"` becomes three characters), which a
byte range cannot represent. The plan is still that a string token keeps the raw
span including quotes and escapes and unescaping moves to whoever needs the value —
but that consumer can now produce a real `string`, by unescaping into a
`packages/bytes` `Buf` and calling `toStr()`, rather than being unable to represent
the result at all. The differential test can compare either that string against the
TS token's text directly, or the span unescaped host-side.

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

Rung 1 not yet started. Nothing here is wired into `deno task test` until a rung
passes its differential test.
