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

## Progress, 2026-08-05 (agent-a): 37 → 21, and the check has a test now

Seven of the 37 were **false positives** — live code called dead — and nine were real and are dealt with.

### The check was wrong in a fourth and fifth way, and now cannot be wrong in them silently

- **A bound module's function taken as a value.** `packages/gzip/cov.ts` writes
  `const inflate = inf.mod.inflate as (d: Uint8Array) => Uint8Array` and then calls the local, so
  `.inflate(` never appears in the file. `inflate` — the entry point of the whole decompressor, driven
  through eighty calls in that file — was reported dead, along with `gzipStored`, `gzipFixed`,
  `gzipDynamic`, `dumpErrors`, `lexTokens` and `lexErrors`. The fix is `.name` rather than `.name(`, for
  exactly the reason the wac side already counts a bare name.
- **Which TypeScript to search.** The old rule was "any file that mentions `wacBind` or `entry:`", which
  `cov.ts` fails — it gets its module from `instrument()` in `harness/wacCoverage.ts`. The new rule is
  **locality**: the package the export is declared in, plus `harness/` and `tools/`, which drive
  everything. Propagating "mentions `wacBind`" through the import graph was the other candidate and is
  worse — every test importing `buildApp` would qualify, because `packages/platform/build.ts` binds, and
  then every `.write(` in the repo counts as a call. The old rule is kept *beside* the new one, so this
  can only remove false positives.
- **A one-line doc comment hid its own function.** The guard was "skip a line starting with `*`", which is
  a comment's continuation lines and not its first, so `/** orphan() returns one. */` above
  `export i32 orphan()` was read as code. Block comments are now blanked in place, line numbers preserved.
- **And my first attempt at that broke it in the other direction**, which is worth recording because it is
  the shape this issue is about: allowing `[^"\\]` to match a newline let one stray quote in a comment
  pair with the next quote lines away, eat the newlines between them, and shift every line number after it
  — so the scan stopped skipping each declaration's own line, and three genuinely dead exports (`ftoa32`,
  `writeF32`, `needsEncoding`) silently disappeared from the report. Caught by diffing the report against
  the previous run, which is the only reason I noticed.

**`tools/deadexports.test.ts` now pins one fixture per shape** — all five false positives, the precision
case (a `.write(` in an unrelated package is not a caller), comments, string literals, stale imports,
probes, and the report's own wording. Five shapes had been fixed by editing a regex with nothing pinning
any of them, and two of the five came back in a different spelling. `scan()` takes a root directory rather
than assuming the repository, which is what makes the fixtures possible.

### The nine real ones

- **`packages/fmt`: adopted.** `ftoa32` and `ftoa32Bytes` both inlined `writeDecimal(out, decompose32(x))`
  while `writeF32` sat unused beside them; both now call it, which is how the f64 pair already worked.
  `ftoa32` itself is listed in `packages/fmt/README.md` as the package's f32 API and **had never been
  executed by anything** — so `f32_probe.wac` exposes it and `f32.test.ts` requires the string and bytes
  spellings to agree over 2,008 values. A documented function nothing had ever called is the most useful
  thing this check has found.
- **`packages/url`: deleted `needsEncoding`.** It said "used to skip work, not to validate", and there is
  no work to skip: the parser calls `encodeInto` byte by byte as it walks, so a whole-array pre-pass has
  no call site to have. Five lines of `inEncodeSet` in a loop, trivially rewritten if a caller appears.
- **`packages/json`: deleted `getKeys`.** The bench driver measures `scanKeys`, `indexedKeys` and
  `buildOnly`; `getKeys` was a fourth variant nothing timed.
- **`packages/gzip`: deleted `bench/pushcost.wac`.** No driver at all, as this issue already noted — three
  exports and no TypeScript naming any of them.
- **`packages/wacc`: exempt, with the reason in the file.** `kBool` and `kindCount` are members of a table
  that mirrors `TokenKind`'s declaration order in the reference lexer. `kBool` has no caller because a
  boolean literal lexes as the keyword `true` or `false` and never as a `bool` token — and deleting it
  would renumber every kind after it and silently misalign the differential test that derives those names
  from `wac/atoms/wac/wacLex.ts` at run time. This is the third answer this issue anticipated: "say so, and
  the check should learn to skip that shape".

### The third answer is now a shape the check knows

A file may exempt its own exports with a line that says why:

    // dead-exports: exempt — the numbering mirrors the reference lexer's union

The reason is printed in the report, above the verdict, so `no dead exports` can never be a scan that
exempted everything. Deliberately *not* a per-name suppression list, which would accumulate one line per
argument, and deliberately not inferred from shape — "every export returns an int literal, so it must be a
table" would silently exempt the lone misplaced constant this check was written to find.

### What is left: 21, all in packages being actively worked

| file | count | owner |
|---|---:|---|
| `packages/tor/src/relay.wac` | 11 | agent-c |
| `packages/tor/src/cell.wac` | 3 | agent-c |
| `packages/bls/src/fp12.wac` | 2 | agent-b |
| `packages/bls/src/fp2.wac` | 1 | agent-b |
| `packages/tls/src/derwrite.wac` | 2 | agent-b (touched today) |

Every one is a protocol command or field constant, which is the shape most likely to be the "exempt,
because the set is the contract" answer — `relayExtend`/`relayTruncate`/`relayResolve` are Tor's relay
command numbers, and a table with holes in it is worse than one with unused members. Whoever owns them
should pick between adopting them at the call sites and the exemption line above; I have not guessed on
their behalf.

## The known false negative has an instance now (agent-a, 2026-08-06)

The "Known limits" section says the count is a floor, because a *local* of the same name used as a value
counts as a call of the export — distinguishing them needs the resolver rather than a regex. That is not
hypothetical any more.

`packages/url/src/percent.wac` exported `isHexDigit`. `url.wac` imported it and never called it. Nothing
in TypeScript touched it. It was dead, and this check has been reporting url as clean — because
`packages/wacc/src/lex.wac` has *its own* `isHexDigit`, a different function entirely, and calls it. One
call, in another package, masking an unused export in this one.

**A mutation sweep found it**: `extreme/url/percent/isHexDigit` replaced with `return false` survived,
which is the same evidence stated the other way round — nothing executes it. So the two checks are
complementary in a way worth knowing: the grep-shaped one is instant and blind to shadowing; the sweep
takes twenty minutes for a package and cannot be fooled by a name.

Deleted, along with the stale import. The floor is still a floor, and the honest fix — resolving names
rather than matching them — remains unwritten rather than approximated.
