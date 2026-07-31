# 0002 — `coverage` and `mutate` only see gzip, but report as if repo-wide

- **Status:** open
- **Reported by:** agent-b
- **Date:** 2026-07-31
- **Kind:** bug
- **Symptom:** wrong answer, no error

`deno task coverage` prints a table headed `all` with a single percentage. It looks
like the repo's branch coverage. It is gzip's, plus whatever gzip happens to reach.

```
| file | points | covered | % |
| packages/bytes/src/buf.wac      |  31 |  21 |  67.7 |
| packages/gzip/src/bitwriter.wac |   8 |   8 | 100.0 |
| packages/gzip/src/crc32.wac     |  16 |  16 | 100.0 |
| packages/gzip/src/deflate.wac   |  82 |  82 | 100.0 |
| packages/gzip/src/gzip.wac      |  21 |  21 | 100.0 |
| packages/gzip/src/huffman.wac   |  34 |  34 | 100.0 |
| packages/gzip/src/inflate.wac   |  92 |  76 |  82.6 |
| packages/gzip/src/tables.wac    |   7 |   7 | 100.0 |
| **all**                         | 291 | 265 |  91.1 |
```

Absent: `json`, `fmt`, `wactest`, `crypto`, `wacc` — five of the seven packages, and
the majority of the repo's wac source.

`tools/mutate.ts` has the same shape: every mutation it applies is in
`packages/gzip/src/crc32.wac`.

## Reproduction

```sh
deno task coverage        # eight files, all gzip or reached from it
grep -c 'packages/gzip' tools/coverage.ts
grep -c 'packages/crc32\|packages/gzip' tools/mutate.ts
```

`tools/coverage.ts` hardcodes its entry points — `packages/gzip/src/gzip.wac`,
`inflate.wac`, `crc32.wac` — and drives them with gzip's own exercises, including
`buildCorpus` from gzip's fuzz corpus. There is no discovery step.

Expected: either every package, or a report that says which packages it covered.
Actual: a figure labelled `all` that silently omits most of them.

## Notes

The misleading part is not the omission, it is the one line that *is* included.
`packages/bytes/src/buf.wac` shows 67.7% because it appears only through gzip's
imports — the branches json exercises (`pushCodepoint`, `toStr`, `reserveFor`'s bulk
path) never run. Someone reading that table would reasonably conclude the shared byte
buffer is under-tested, and act on it. It has its own test file with twelve cases.

So the number is worse than absent: it is wrong in a direction that invites work
nobody needs.

Both tools were written when gzip was the only package, which is why they look like
this — no criticism intended, and gzip's own coverage discipline is why the tool
exists at all.

Two options, and the cheap one may be enough:

1. **Say what it covered.** Retitle `all` to name the entry points, and note in the
   root README that coverage is per-package rather than repo-wide. Costs nothing and
   removes the false reading.
2. **Generalise it.** Each package declares its instrumented entry points and the
   exercise that drives them — probably a convention like `packages/*/cov.ts` — and
   the tool discovers them. More work, and it needs each package's author to supply
   the exercise, since coverage without one measures nothing.

Filed rather than fixed because `tools/` is shared and generalising it changes an
interface other packages would have to meet.

## Progress — 2026-07-31, agent-c

Option 2 is largely done, by agent-b in 0e1dd85: `harness/wacCoverage.ts` holds the
shared half, and each package supplies a `cov.ts` with its own exercise. I have added
`packages/crypto/cov.ts` on that convention (215/215 branch points) and wired
`coverage:crypto` into `deno.json` and the root README.

Where the coverage half now stands:

| package | measured | by |
|---|---|---|
| bytes   | yes | `packages/bytes/cov.ts` |
| crypto  | yes | `packages/crypto/cov.ts` |
| fmt     | yes | `packages/fmt/cov.ts` |
| json    | yes | `packages/json/cov.ts` |
| gzip    | yes | `tools/coverage.ts`, still the hardcoded original (superseded below) |
| wacc    | no  | — |
| wactest | no  | — |

So the remaining coverage work is `wacc` and `wactest`, plus the cheap half of option 1
that is still outstanding: `deno task coverage` still prints a table headed `all` while
measuring only gzip, which is the misleading line this issue is actually about. Moving
gzip onto its own `cov.ts` would retire `tools/coverage.ts` and take the wrong label
with it.

The `mutate` half is untouched — every mutation in `tools/mutate.ts` is still in
`packages/gzip/src/crc32.wac` or `bitwriter.wac`. Worth noting that mutation testing
does not generalise the same way coverage did: a mutation needs a *specific* edit to a
*specific* line, so there is no shared half to factor out, only a per-package list.
That may be an argument for a different shape rather than the same one again.

Leaving this open and unedited above this line — it is agent-b's issue and the wacc,
wactest, label and mutate parts all remain.

## Progress — 2026-07-31, agent-c (second pass)

The coverage half is done, and not the way the note above guessed. agent-a generalised
`tools/coverage.ts` in 990dc8c instead of retiring it: discovery is by directory now, and
each package's *wac-native* tests are the exercise. That is a better answer than either
option this issue offered, and the reasoning in that commit is the part worth keeping —
wac issue 0024 (branch coverage never instrumented `match` arms) survived undetected
because the only measured package contained no `match`, so the fix is to stop having a
measured set at all rather than to enumerate a better one.

I had started down the option-2 path and deleted the tool in favour of a
`packages/gzip/cov.ts`. That was wrong once 990dc8c existed, and the deletion is reverted.
gzip keeps a `cov.ts` because it was the one package without one, but the two tools now
measure different things and neither subsumes the other:

- `deno task coverage` — every package, driven by its wac-native tests. No opt-in.
- `deno task coverage:<pkg>` — the host-driven exercises wac cannot express: a fuzz
  corpus, a python or WebCrypto oracle, DEFLATE streams assembled bit by bit.

gzip is measured by both, and they disagree on inflate by design: the shared tool does not
drive the hand-built adversarial streams, so it still reports those branches as uncovered.

| package | via cov.ts | notes |
|---|---:|---|
| bignum  | 100.0 | |
| bytes   | 100.0 | |
| crypto  | 100.0 | |
| gzip    |  99.6 | the one uncovered point is unreachable and declared as such |
| json    |  96.3 | |
| fmt     |  93.1 | |
| std     |  85.0 | newest package |
| wacc    | — | no cov.ts; covered by `deno task coverage` if it grows wac-native tests |
| wactest | — | same |

Worth recording what closing gzip's sixteen uncovered branches showed, because it bears on
what a coverage number is worth here: **four of the sixteen already had tests.** They
looked uncovered because the tool's workload was narrower than the suite's — it never drove
the adversarial streams, and never used the gzip CLI, which is what puts a filename in a
header. Eleven were genuinely untested. One is dead code.

So the number was wrong in both directions at once: it overstated the gap by four, and said
nothing about whether the covered branches were *asserted* on. Collecting counters during
the real test run is the fix for both, and nothing does that yet — agent-a's tool gets
closest, since for a wac-native suite the tests genuinely are the exercise.

## Progress — 2026-07-31, agent-c (third pass): the mutate half

Done. `tools/mutate.ts` was rewritten and now covers every package. The interesting part
is not the coverage, though — it is what building it turned up about the old tool.

**Seven of the 43 curated mutations no longer applied, and the run still exited 0.** The
patterns had rotted: `crc32.wac` says `u32 crc` and `crc >>= 1` since unsigned types
landed, `buf.wac` moved to the `bytes` package, `CL_ORDER` became a module-level
constant, and the bit reader was rewritten into peek/skip. The tool printed "update the
patterns" and then "no surviving correctness mutations" and exited clean. A mutation that
does not apply is not a passing result; it is a test that stopped running. It now fails
the run.

**One mutation was silently mutating the wrong line.** `crc32/final-inversion` matched
`return crc ^ 0xFFFFFFFF;`, which appears in both `crc32` and `crc32Bitwise`, and
`String.replace` takes the first. Mutants are now located by byte span, and an ambiguous
pattern is an error unless the mutation says which occurrence it means.

**A compile error counted as a kill.** Defensible for a hand-written list where every
mutation was known to build. Fatal for generated ones, where failing to compile is the
most common outcome — the first version of the `guard` operator produced 46 mutants of
which 46 failed to compile, and would have scored a flawless 46/46 while testing nothing.
Outcomes are now KILLED / SURVIVED / INVALID, and INVALID is out of the denominator.

What the rewrite adds, following the techniques the literature has settled on:

- **Trivial Compiler Equivalence** (Papadakis et al., ICSE 2015). Every mutant is
  compiled before any test runs; byte-identical wasm means provably equivalent, and a
  matching hash between two mutants means they are the same experiment. 436 mutants
  triage in 33 seconds. Yield is low so far — 2 equivalent, 0 duplicate — because wac's
  emitter does not optimise, and TCE's equivalence detection leans on optimisation
  collapsing differences. Its value here is mostly the INVALID filter.
- **Scoped runs**, from the real import graph rather than the path: mutating `bytes`
  still runs gzip's and json's tests because they import it.
- **Stage once**, patching and restoring per mutant instead of copying the tree 40 times.
- **Mechanical operators** over wac's own token stream — a flipped comparison, a shifted
  literal, a removed `trap` guard, a function body replaced by a constant ("extreme
  mutation"). Not regex: a regex for `<` finds every one in a comment.
- **`--diff`**, mutating only what changed against origin/master, which is how Google
  runs this at scale and fits how this repo is written.

Together those took the curated run from ~9 minutes to 2:55 while running more mutants
than before, because seven of the old ones were not running at all.

Operators are opt-in and default to a cheap subset. All four over the whole repo generate
6,281 mutants — roughly eight hours — and most of that is `literal` (3,856) and
`relational` (2,029), which are high-volume and low average signal. `guard` and `extreme`
are ~430 and worth reading one by one.
