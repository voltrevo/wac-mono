# 0005 — 54 surviving mutants: behaviours nothing checks

- **Status:** open
- **Reported by:** agent-c
- **Date:** 2026-08-01
- **Kind:** task
- **Symptom:** wrong answer, no error

`deno task mutate:operators` now covers every package. The first full run:

```
434/497 mutants killed
discarded: 4 provably equivalent (TCE), 0 duplicate, 5 uncompilable
58 surviving
```

Four of the 58 are already fixed (crypto, see 9c937ce) and one is documented as
genuinely equivalent, leaving **54 open**. A surviving mutant means the code was
changed and no test noticed — which is the failure branch coverage cannot show, since a
test can execute a line thoroughly and assert nothing about what it did. Every package
here is at or near 100% branch coverage.

| package | survivors |
|---|---:|
| wacc    | 20 |
| gzip    | 18 → resolved, see below |
| fmt     |  4 |
| std     |  3 |
| json    |  3 |
| url     |  2 |
| bignum  |  2 |
| wactest |  1 |
| crypto  |  5 → fixed in 9c937ce |

Reproduce any one of them with `deno task mutate --operators=guard,extreme --package <pkg>`.

## The two patterns worth reading first

**wacc: error codes are never checked by value.** Sixteen of wacc's twenty are
constants — `errUnexpectedChar`, `errUnterminatedString`, `perrExpected`, `perrBadType`,
`perrTopLevel`, `kBool`, `kindCount` — and replacing the body with `return 0` survives.
This is not a surprise so much as a confirmation: `test/lex.test.ts` says so out loud,
"the wac side reports codes rather than messages, so the mapping is checked by the order
they occur in". Positions and counts are compared against the reference; the codes are
not. Two distinct errors could share a code, or every code could be zero, and the suite
would stay green.

That matters more than it looks, because rung 3 compares type-checker diagnostics and
the plan is to compare them by position too. The rungs are being built on a comparison
that does not check the one field wacc uses to say *what went wrong*.

**gzip: twelve inflate guards.** Resolved — the question was asked of each one by
removing the guard and re-running a probe built to reach exactly that check.

Eleven are genuinely redundant with a bounds check: the next thing the code does is
index an array outside its bounds, and WasmGC traps unconditionally. One of those
eleven, `di >= 30`, is not even reachable. All are recorded in `tools/mutate/known.ts`
with the argument and the confirmation, and they stay in the source because a named
rejection beats an out-of-range read.

The twelfth was a real gap, and it was the one that looked most like the others.
`hlit > 286 || hdist > 30` deleted, an otherwise-valid dynamic block declaring 287
literal codes **decodes and returns successfully** — nothing else objects, because
symbols 286 and 287 simply have no code assigned. The test that was supposed to cover
this sent a header and stopped, so the stream ran out of bits and trapped whether or not
the count was checked: it reached the line without testing it. Same shape as the crypto
guards, where every test passed a short input that traps either way. Fixed by building a
complete block whose only fault is the count.

That is eleven arguments and one bug from twelve mutants that all looked alike, which is
the case for asking rather than assuming.

## The rest

```
extreme/gzip/crc32/sliceThreshold      extreme/gzip/deflate/goodLength
extreme/gzip/deflate/niceLength        extreme/gzip/gzip/smallInput
extreme/gzip/inflate/rootBits          extreme/gzip/inflate/maxSizeHint
extreme/fmt/atof/approxBits            extreme/fmt/ftoa/ftoa32
extreme/fmt/ftoa/writeF32              guard/fmt/ftoa:230:23
extreme/std/hash/hashI32               extreme/std/hash/hashI64
guard/std/vec:39:25                    extreme/url/percent/isHexDigit
extreme/url/percent/needsEncoding      guard/bignum/big:316:17
guard/bignum/big:340:19                extreme/wactest/assert/utoa
```

Several of the `extreme` ones are tuning constants — `sliceThreshold`, `goodLength`,
`niceLength`, `rootBits` — where a survivor may be the same "ratio only, not
correctness" category the curated list already marks. That is a judgement per constant,
not a blanket excuse: `rootBits` is a decoder table size, not a tuning knob, and
`maxSizeHint` bounds an allocation from attacker-controlled input.

`extreme/fmt/ftoa/ftoa32` and `writeF32` surviving while their f64 twins are killed
suggests the 32-bit path is tested much more thinly than the 64-bit one.

## Notes

Not fixing these here because they span six packages other people are working in, and
because the answer differs per mutant — some want a test, some want a recorded argument
for why they cannot be killed. `tools/mutate/known.ts` is where the second kind goes,
with the same standard as gzip's UNREACHABLE list: an argument with evidence, and an
error if the mutant later gets killed.

A survivor is not automatically a bug. It is a question about whether the tests check
what they appear to check, and the useful thing is that there are now 54 specific ones
instead of a percentage.
