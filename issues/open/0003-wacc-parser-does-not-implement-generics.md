# 0003 — wacc's parser does not implement generics, so `std` is outside its corpus

- **Status:** open
- **Claimed by:** agent-a (2026-08-04)
- **Reported by:** agent-a
- **Date:** 2026-07-31
- **Kind:** missing feature
- **Symptom:** not implemented

## What

wac gained generics (wac issue 0034: generic structs, generic functions, generic enums).
`packages/std` uses them. `packages/wacc`'s parser does not implement them, so the
differential test — which parses every `.wac` file in the repo and compares against the
reference parser node for node — cannot read those seven files.

They are **skipped and reported**, not silently dropped:

```
  parse: 54 files
  parse: SKIPPED packages/std/src/map.wac — uses generics, which wacc's parser does not implement (issue 0003)
  ...
```

`loadCorpus("parse", { skipGenerics: true })` does it, and `usesGenerics()` in
`packages/wacc/test/corpus.ts` decides by asking the reference parser rather than by pattern-
matching the text, so a new file that uses generics is skipped automatically rather than
turning the suite red. The lexer rung is unaffected: `<` and `>` were always ordinary tokens.

## What it takes

Three pieces, in the order the reference implementation added them:

1. **`typeParams` on a declaration.** `struct Vec<T>`, `enum Option<T>`, `T max<T>(T a, T b)`
   — an optional `<A, B>` after the name, in all three. The reference has one
   `parseTypeParams()` used by all three declaration parsers.
2. **`typeArgs` in a type.** `Vec<i32>`, `Map<string, Vec<i32>>`, `Box<i32>?[]`. The one
   catch is that `>>` closes a nested list and the lexer has already munched it into a shift
   token, so the parser splits it — the reference calls this `replaceCurrent(">")`.
3. **The lookahead that tells a declaration from an expression.** `Vec<i32> v = ...` has to
   be recognised as a variable declaration, and `a < b > c` must not be. The reference scans
   forward from `ident <` tracking bracket depth; both halves of that are already load-bearing
   and both have had bugs (wac commits for `Box<fn[i32(i32)]>` and for
   `MapEntry<K, V>?[8]()`).

Nothing about *monomorphisation* is needed. Generics are substituted in the resolver, and
wacc is at rung 2 — a parser. What it needs is to produce the same AST the reference does,
with the type parameters and arguments recorded on the nodes.

## Why it is worth doing rather than leaving skipped

The corpus is the whole value of the differential test, and `std` is now the most
generics-dense wac code in existence. Skipping it means rung 3 and later inherit a blind
spot in exactly the part of the language that is newest — and the parser's own generic
lookahead is where the reference implementation has had two of its bugs.
