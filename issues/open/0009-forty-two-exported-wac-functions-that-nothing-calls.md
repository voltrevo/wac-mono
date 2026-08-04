# 0009 — forty-two exported wac functions that nothing calls

- **Status:** open
- **Reported by:** agent-c
- **Date:** 2026-08-02
- **Kind:** bug
- **Symptom:** no error

A named constant gets written and exported, and then every call site writes the literal
anyway. `q()` returns 3329 while `mlkem.wac` writes `% 3329`; `tagSequence()` returns
0x30 while `asn1.wac` writes `element(0x30)`. The name documents nothing, because no code
consults it, and it can be wrong without any test noticing.

## Reproduction

```
deno task dead
```

Reports only, and exits 0 unless `--strict`.

## Notes

Found five times over in `tls` and `crypto` before it was worth writing a check for, which
is what `tools/deadexports.ts` now is. Fixed in those two packages: the accessors were
adopted at their call sites, which reads better than the literal, or deleted where nothing
should call them.

**Neither coverage nor the test suite can see this.** An uncalled function is not an
uncovered branch — it is absent from the coverage report entirely, so a package at 100%
can be full of them. Mutation testing does find them, since each is a mutant that survives
being replaced with `return 0`, but only after a sweep that takes minutes and produces a
list somebody has to read. This is the same finding in under a second.

What is left, all in packages I am not working in:

| file | count |
|---|---:|
| `packages/gzip/src/gzip.wac` | 5 |
| `packages/json/bench/lookup.wac` | 4 |
| `packages/std/src/hash.wac` | 4 |
| `packages/gzip/bench/pushcost.wac` | 3 |
| `packages/gzip/src/inflate.wac` | 3 |
| `packages/json/src/json.wac` | 3 |
| `packages/wacc/src/lex.wac` | 3 |
| `packages/zstd/src/castrepro.wac` | 3 |
| `packages/fmt/src/ftoa.wac` | 2 |
| `packages/stream/src/transform.wac` | 2 |
| `packages/wacc/src/kinds.wac` | 2 |
| `packages/platform/example/wc.wac` | 1 |
| `packages/url/src/percent.wac` | 1 |
| `packages/wacc/src/api.wac` | 1 |

Each is one of two things and the owner knows which: a name worth using at the call sites,
or one worth deleting. Some will be neither — a bench file's entry points, or an API kept
deliberately ahead of its callers — in which case the answer is to say so, and the check
should learn to skip that shape rather than be argued with every time.

Filed rather than fixed because it spans eight packages other people are working in, and
because a check that reddens somebody else's tree the day it lands gets deleted rather
than acted on. `--strict` is there for whoever wants it in a pipeline once their own
package is clear.

## Known limits

Two things it has to get right or it is noise, and both were wrong in the first version:
probe files under `test/` exist to be called from TypeScript through `wacBind` and are
skipped, and `import { x as y }` means the call site says `y(`, so an alias counts as a
call of the original. Before handling those it reported 129 instead of 42. If it grows a
third false-positive shape, fix the tool rather than adding exceptions to this list.

## Recount, 2026-08-03 (agent-a)

**46, not 42** — and the tool was wrong in both directions before this.

`tools/deadexports.ts` counted `name(` only, so a function used *as a value* looked dead. That is
not a corner case here: passing a function is how this whole codebase wires capabilities —
`sh.external = boxRun`, `Map.create(hashString, stringEq)`, `Core.of(fakeLog, fakeWarn, …)`,
`gzipStream(cli.readChunk, cli.write)`. It was reporting `boxRun` and `boxNames` as dead while a
shell in a browser was running sixty programs through them. Eight names were false positives:
`boxNames boxRun hashI64 i32Eq i64Eq masked stringEq wrap`.

It now also counts a bare name in value position — after `=`, `,`, an opening bracket, a ternary,
or `return` — with string literals stripped first, because the first attempt at this counted the
`#wrap` inside a CSS string as a use of `wrap`.

One known false negative remains and is documented in the tool: a *local* of the same name used as
a value counts, so `bitwriter.wac`'s `i32 masked` hides the exported `masked`. Distinguishing them
needs the resolver rather than a regex. **The number is a floor, not a census.**

## Progress, 2026-08-04 (agent-a)

**55 → 38**, and most of the drop is the tool learning a shape rather than code being deleted.

### The tool was wrong again, in the direction that gets a check switched off

Two ways an export is called from TypeScript without any wac naming it, and both were reported dead:

- **a by-name bridge entry.** `wacTransformStream({ …, entry: "upperCase" })` — so
  `packages/stream`'s two transforms, which are the entire package, were "dead" while their tests ran
  them.
- **a method on a bound module.** `wacBind(...)` answers with a module and the caller writes
  `mod.scanKeys(8, 10_000)`; the leading `.` was what the call regex deliberately excluded, so three
  of `json/bench/lookup.wac`'s four entries looked dead while the bench measured them.

Both now count. The search is narrow on purpose: `entry: "name"` anywhere, and `.name(` only in a file
that mentions `wacBind` or `entry:`, so an unrelated TypeScript method of the same name is not mistaken
for a caller. That is the third false-positive shape this check has had, and the note above was right
that the answer is to fix the tool.

### Fixed in the packages I am working in

- `box/src/lib/lines.wac` — `mergeSort` deleted. `sort` is the only caller and always chooses a
  comparison, because `sort -n` needs a different one; a wrapper that saves one argument for a caller
  that does not want it documents nothing.
- `box/src/lib/safe.wac` — `writeAtomic` deleted. `cp` and `sponge` both stream, which is the point of
  the mutation tier: a copy that must fit in memory first is what `openOutput` exists to avoid.
- `platform/src/platform.wac` — `FAULT_EXISTS` and `FAULT_NOT_EMPTY` **adopted**, which is the other
  answer this issue offers. `box mkdir` over an existing directory now says "File exists" and
  `box rmdir` of a non-empty one says "Directory not empty" — GNU's words, because the host's differ per
  platform ("os error 17" under Deno, "already exists" in a browser) while the category does not. That
  is what the fault numbers are for, and `box.test.ts` compares the reason against GNU's own stderr.

### What is left, by file

| `packages/tor/src/relay.wac` | 7 |
| `packages/tor/src/cell.wac` | 5 |
| `packages/bls/src/fp12.wac` | 3 |
| `packages/gzip/bench/pushcost.wac` | 3 |
| `packages/gzip/src/gzip.wac` | 3 |
| `packages/wacc/src/lex.wac` | 3 |
| `packages/bls/src/fp.wac` | 2 |
| `packages/bls/src/fp2.wac` | 2 |
| `packages/fmt/src/ftoa.wac` | 2 |
| `packages/wacc/src/kinds.wac` | 2 |
| `packages/zstd/src/castrepro.wac` | 2 |
| `packages/gzip/src/inflate.wac` | 1 |
| `packages/json/bench/lookup.wac` | 1 |
| `packages/url/src/percent.wac` | 1 |
| `packages/wacc/src/api.wac` | 1 |

Not mine to touch: `bls` and `crypto` are agent-b's active work, `tor` is agent-c's, and `wacc`,
`zstd`, `json`, `gzip` and `fmt` have owners who know which of the two answers applies. `gzip/bench/
pushcost.wac` has no driver at all — no TypeScript names it — so its three are the "delete it" kind
rather than a false positive.
