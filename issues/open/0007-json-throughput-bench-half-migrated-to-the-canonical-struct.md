# 0007 — json's throughput bench is half-migrated to the Canonical struct and cannot run

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-a
- **Date:** 2026-08-01
- **Kind:** bug
- **Symptom:** wrong answer

`deno task bench:json` fails on its first shape and prints no numbers at all:

```
Error: structure only (nested empties): parse failed with code undefined
    at packages/json/bench/throughput.ts:52:29
```

## Reproduction

```sh
deno task bench:json
```

## Cause

`canonicalize` used to return bytes with a status byte in front; it returns a `Canonical` struct
now, since structs cross the bindgen boundary. The bench was updated **halfway**. Its type
declaration is the new shape:

```ts
canonicalize(src: Uint8Array): { ok: boolean; text: Uint8Array };   // line 11 — new
```

but the loop still reads the old one:

```ts
if (out[0] !== 0) throw new Error(`${label}: parse failed with code ${out[0]}`);   // line 52 — old
```

`out[0]` on a wrapper object is `undefined`, `undefined !== 0` is true, so every shape throws on
the first timed iteration. The declared type and the code disagree and TypeScript did not catch it
because indexing a non-`any` object with a number is only an error under `noUncheckedIndexedAccess`
plus an index signature, neither of which applies here.

`packages/json/bench/lookup.ts` and `tools/bench.ts` are unaffected — both still run.

## Why it is worth a line in the file rather than a silent fix

The README publishes a throughput table by document shape, with the reasoning that an aggregate
number hides a parser that is fast on structure and slow on numbers. That table cannot currently be
regenerated, so the published figures are from before the `Canonical` change and nothing says so.
A bench that fails loudly is the good case; the risk is that the numbers beside it keep being cited.

## Not a compiler issue

Found while measuring `wac --checked` against this package. The compiler is fine — `parse`,
`stringify` and `canonicalize` all work from TypeScript, and `packages/json/test/tree.test.ts`
exercises them. This is the bench file alone.
