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
| gzip    | 18 |
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

**gzip: twelve inflate guards are redundant with a later check.** These are the
rejection paths I added tests for in 0acf481, and the tests do pass. Removing the guard
still rejects the input — just later and for a different reason. `hlit > 286` removed
means symbol 286 decodes and then trips `li >= 29`; a stored block's bad `NLEN` removed
means the length runs off the end and trips the bounds check.

Whether that is a gap or a fact depends on the guard, and the crypto ones show it can go
either way. There, four of five guards looked equally redundant and were not: every test
passed a *short* input, which traps with or without the check, while a *long* input is
read happily — a 17-byte AEAD tag whose first 16 bytes are valid verified successfully
with the length check removed. The short case had exercised the guard without testing
it. Each of gzip's twelve needs the same question asked: is there an input on the other
side of the boundary that the later check does not catch?

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
