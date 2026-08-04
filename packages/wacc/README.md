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

## Generics, and two constructs that came with them

The parser reads type parameters and type arguments — `struct Vec<T>`, `T max<T>(T a, T b)`,
`Map<string, Vec<i32>>`, `Vec<i32>[2](fill: …)` — which is
[wac-mono 0003](../../issues/closed/0003-wacc-parser-does-not-implement-generics.md). Until it did,
twenty-five files were skipped by name, including all of `packages/std`, which is the most
generics-dense wac in existence: the corpus is the whole value of a differential test, and a blind
spot in the newest part of the language is the worst place to have one.

Three pieces, and the awkwardness is all in the third:

- **`typeParams` on a declaration** — an optional `<A, B>` after the name of a struct, an enum or a
  function. One parser, three callers.
- **`typeArgs` in a type** — and the lexer has already munched `Vec<Vec<i32>>`'s close into a single
  `>>`, so the parser consumes one `>` worth and rewrites the rest in place, position included.
  `>>>` closes three. `P.toks` being mutable is what makes that possible.
- **Two lookaheads.** `Vec<i32> v = …` is a declaration and `a < b > c` is not; `Vec<i32>(…)` is a
  construction and `a < b` is not. Both scan for a *balanced* `<…>` followed by something that settles
  it, and both track parentheses and brackets, because `Box<fn[i32(i32)]>` contains both and a scan
  that stopped at the funcref's own `)` read the declaration as an expression. The reference has had a
  bug in each of them separately, which is why `afterTypeArgs` is one function here.

Two more constructs came with the same corpus, both of which the working half of the corpus happened
not to contain:

- **`match` as an expression** (`case P: value,` arms), which is how half of `Option<T>` is written.
  `Arm` gained a `value`, so one arm type serves both forms — a body for the statement, a value for
  the expression.
- **methods in an enum body**, which `Option<T>` has six of. A method is told from a variant by shape
  (`type name(this, …)` is not something a variant can look like), and `override` on one is refused as
  the reference refuses it.

`const` on a parameter is the one thing still behind, and only in the language rather than in this
parser: the AST field exists and the parser accepts it, but wac itself does not allow `const` on a
free function's parameter, so the read-only intent of the lookahead helpers here cannot be stated.

## Status

**Rung 2 (parser) passes.** The AST it builds agrees with the reference node for node, positions
included, on all 217 `.wac` files in the repo plus the language tour — nothing is skipped any more —
and on 74 hand-written cases a working corpus cannot contain (every precedence level, every cast,
`else if` chains, bare-statement `switch` bodies, trailing commas everywhere, char and string escapes,
malformed types, a nested `>>>` close, a funcref inside a type argument, and the comparisons that must
*not* be read as type arguments).

**Rung 1 (lexer) passes.** Token for token, position for position, against the reference on the same
217 files plus 32 adversarial cases the corpus cannot cover (unterminated everything, every escape,
greedy operator runs, non-ASCII columns).

Next: rung 3, the type checker.

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

## What rung 2 cost, in language terms

**The AST is sum types, and that was the point.** It began as a flat integer node
pool, because wac had no alternative when it was written. Porting it to `enum` removed:

- `pack2` / `unpackLo` / `unpackHi` / `none` — the whole bit-packing convention, which
  existed only because a record held three fields and `for` and `func` needed four.
- The single tag space, which forced `sCase` to be a statement and `dParam` a
  declaration. Case clauses, params, fields, methods, variants and import items are
  now ordinary structs.
- Every untyped integer field access. `a`, `b` and `c` meant something different per
  tag and nothing checked it; the comments were the only schema.

`print.wac` is the payoff made concrete: 5 exhaustive `match` statements over 49
variants, written in one pass and compiling first try. The same walk over the node
pool would have been a chain of integer comparisons with a silent fall-through, and
adding a variant would not have broken it.

**Positions had to be exactly right, and guessing was expensive.** Three divergences
cost real time, all of them the reference doing something not inferable from the
grammar:

- Each `[]` or `?` suffix on a type carries *its own* token position, not the base
  type's. 34 of 42 corpus files disagreed on this alone.
- A malformed type is reported and **substituted** with `i32` without consuming a
  token. Advancing instead desynchronises the two parsers for the rest of the file.
- After `is`, whether the right side is a type or a value is decided by **naming
  convention** — a lowercase initial means a variable. A plausible approximation of
  this read `(a is b)` in the tour and `byStr! is byBytes!` in the json tests as type
  tests.

Every one of those was found by the differential test and none would have been found
by a test written from the same understanding as the implementation.

**Thirteen growable-list structs, character-identical but for the type name.** A
recursive-descent parser collects a list of every node type it builds, and with no
generics each needs its own `push`/`take`. This is now the most-repeated cost of that
gap in the repo, ahead of the four hand-written byte buffers.

**Two bugs of my own, both from the language rather than the algorithm.** A
zero-argument `XList()` default-constructs rather than calling the static `create()`,
so every list started with a zero-length backing array that doubled to zero and trapped
on first push. And `const` on a free-function parameter is not accepted — only `const
this` on a method — so the read-only intent of the lookahead helpers cannot be stated.

**Five compiler bugs found, all in `match`** — reported and fixed upstream in wac
`08fedd2` and `2a5c1c1`. Four were statement walks that predated `match` and were
never extended, so anything reachable only inside an arm was invisible to them; the
fifth was `break` in an arm, which reaches the enclosing loop but which the return
checker assumed did not. A sixth and seventh were enums resolved by name where
identity was meant, which only two files declaring the same enum name could expose.
