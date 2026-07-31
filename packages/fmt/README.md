# fmt

Numbers to and from text.

- `ftoa(x)` — the shortest digit sequence that reads back as the same double,
  formatted exactly as JavaScript's `Number::toString`.
- `atofSpan(src, start, end)` — the double nearest a decimal, ties to even.
  Correctly rounded for every input.
- `itoa(n)` — an `i32` in decimal.
- `ftoa32` / `atof32Span` — the same pair for `f32`.

```wac
import { ftoa, ftoaBytes, writeF64 } from "../../fmt/src/ftoa.wac";

string s = ftoa(0.1);        // "0.1", not the 55-digit exact value
u8[] b = ftoaBytes(1.0e21);  // "1e+21"
writeF64(buf, -2.25);        // straight into a bytes/Buf
```

## Why it exists

Nothing in wac could turn a float into text. `json` could only serialize numbers
it had parsed, by keeping the source span they came from, so a tree built by hand
could not be written at all; `wactest` still cannot put a float in a failure
message. This was the last blocking entry in
`~/notes/living/wac/language-friction-log.md`.

It needed one language addition, `f64.toBits`, since a program that cannot see a
float's representation cannot decompose it.

## Algorithm

Burger & Dybvig's free-format method — Steele & White's Dragon4 restated. The value
is held as an exact rational `R/S` alongside the half-gaps to its two neighbours,
digits come out most-significant first, and the loop stops as soon as the digits
emitted identify this double rather than either neighbour. That stopping rule is
what makes the output *shortest*; the exact arithmetic is what makes it correct.

What a float turned out to be is an `enum` — `NaN`, `Inf(neg)`, `Zero`,
`Digits(...)` — rather than a struct with `isNaN`/`isInf` flags. The flags made
nonsense representable, both set at once or a NaN carrying digits, and every reader
had to know which fields were meaningful in which combination. Formatting is now
exhaustive over the four cases.

One consequence worth knowing before porting anything similar: a variant's payload
cannot be written after construction, so digit generation accumulates in locals and
constructs the variant once at the end. It was a builder in disguise before, so this
made it more honest rather than less.

`src/bigint.wac` is the arithmetic — `FixedBig`: fixed-size unsigned, `u32` limbs with
`u64` intermediates. Deliberately not a general bignum, and named apart from
`packages/bignum`'s `Big` because two structs of the same name in one program is a
compiler bug rather than an error (`wac/issues/0006`) — the algorithm needs compare,
subtract, multiply by a small constant and shift left, and finds each digit by
trial subtraction, so there is no division and no FixedBig×FixedBig multiply.

Ryu would be faster and needs no bignum, but wants two tables of ~600 128-bit
constants; with no module-level constants those become a `switch` of 1200 literals.
Formatting is not a hot path.

Three details carry the correctness, and each was found by a failing case rather
than reasoned about up front:

- **Boundary-inclusive stopping when the significand is even.** With
  round-half-to-even, a decimal landing exactly on the boundary reads back as this
  double, so the boundary is attainable. Getting this wrong does not produce wrong
  digits — it produces one or two more than necessary, which is how it showed up.
- **The exact-tie rule is round-half-to-even on the digit**, not round-up.
  `887976063517795.25` is exactly between `…95.2` and `…95.3`; both round-trip, and
  ECMA-262 picks the even one.
- **Carry propagation on the last digit.** Rounding a 9 up carries, and when it
  carries off the front the value becomes a power of ten at one exponent higher —
  `9.99…e22` is `1e23`, not `10e22`.

## Verification

`String(x)` is the oracle, which is the whole reason for matching JavaScript rather
than choosing a house style. `deno task test` compares 20 000 random bit patterns
and 8 000 random decimals, plus the notation boundaries and the classic hard cases,
and separately asserts every output reads back as the original double.

`deno task verify:fmt` runs the same comparison over 500 000 doubles in both
directions when a change wants more than the suite gives — about nine seconds,
currently zero mismatches. **Run it after touching anything in this package**: the
committed suite samples 28 000 values, which is enough to catch a broken change and
not enough to catch a subtly wrong one.

The bignum has its own tests against the host's `BigInt` (`test/bigint.test.ts`),
because a wrong carry surfaces as one extra digit several layers up, where the
cause is invisible.

## Parsing

`atofSpan` is the mirror of `ftoa` and shares its arithmetic. A fast path handles
short decimals — up to 15 digits with |exponent| ≤ 22 fits an f64's significand
exactly and scales by an exactly-representable power of ten, so one operation is
correctly rounded. Everything else goes to the exact path.

The exact path **bisects the bit pattern**. For positive doubles the bits are
monotonic in the value, so the largest double not exceeding the decimal is found in
63 exact comparisons, and a comparison against the midpoint picks between it and
its successor. No division: comparisons cross-multiply, scaling one side by a power
of ten and the other by a power of two.

An earlier version estimated the answer and stepped by ulps. It failed silently at
both ends of the range, where the estimate was thousands of ulps out — bisection
has no estimate to be wrong.

Digits past 800 are dropped with a sticky flag. They cannot change which double is
nearest; they can only break an exact midpoint tie, which the flag resolves. 800 is
beyond the ~767 digits an exact midpoint can have.

Verified the same way: bit-exact against `Number(s)`, over the boundary cases,
random decimals across the whole exponent range, and *constructed exact midpoints*
— decimals sitting precisely between two doubles, where always-round-up and
always-truncate both fail.

## Speed

Formatting is not on anyone's hot path; parsing is, so it has three tiers.

A scan that allocates nothing decides the common case: up to 19 digits accumulate
into a `u64`, and if the significand is under 2^53 with an exponent inside the
exactly-representable powers of ten, one multiply or divide is the answer.
Clinger's extension stretches that to exponents up to 37 by pushing the excess into
the significand while it still fits.

Only what fails all of that reaches the bignum, and it starts from a **verified**
bracket: a cheap f64 estimate gives a ±4-ulp window, both ends are checked by exact
comparison, and a bad end widens to the full range. The estimate can cost time,
never correctness — which is exactly the distinction the first version of this file
got wrong by trusting one.

Measured through json, MB/s of document:

| document | before | after |
|---|---:|---:|
| small integers | 18.9 | 64.4 |
| simple decimals | 23.9 | 75.7 |
| exponent-form | 0.5 | 8.7 |
| long-mantissa | 1.9 | 20.6 |

Three things got it there, in order of size: not allocating an 800-byte digit
buffer for every number including `1`; hoisting the power-of-ten scaling out of the
bisection, where it had been rebuilt on all 63 iterations; and the narrow bracket,
which cuts those iterations to about three.

## f32

Both directions, sharing the machinery. Digit generation takes the significand,
exponent and boundary rules as parameters, so `f32` is a decomposition and not a
second copy of Burger & Dybvig. Parsing needs its own bisection — the two return
different types and wac has no generics — but the exact comparison underneath is
shared, since it works on a significand and a binary exponent and does not care
where they came from.

`atof32Span` is **not** "parse to f64, then narrow". That rounds twice, and the two
roundings disagree for decimals sitting near an f32 boundary.

JavaScript has no `f32`, so `String(x)` is not the oracle it was for doubles.
Instead the two defining properties are checked directly: the output must read back
as the same `f32`, and no decimal with fewer significant digits may do so. That is
what shortest-round-tripping means, and asserting it is stronger than agreeing with
another implementation.

## Not here yet

- Fixed-precision output (`toFixed`-style). Only shortest is implemented.

## Coverage

`deno task coverage:fmt` reports branch coverage, driven by `cov.ts` in this
package. Currently 94.5% ftoa, 96.5% bigint, 90.7% atof — the remainder is defensive guards and unreachable range checks.

Coverage needs an exercise, and an exercise only measures the code it drives, so each
package supplies its own; `harness/wacCoverage.ts` is the shared half. The repo-level
`deno task coverage` covers gzip only, which is [issues/0002](../../issues/open/0002-coverage-and-mutate-only-see-gzip.md).

The hazard to know about: `cov.ts` is a second workload written by hand, so it drifts
from the test suite it is meant to measure. Twice now it has reported a branch as
uncovered that the tests do cover, and once the reverse. When it disagrees with the
suite, the suite is right and `cov.ts` needs the input adding.
