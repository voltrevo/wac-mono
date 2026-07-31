# fmt

Decimal and `f64`, converted exactly in both directions.

- `ftoa(x)` — the shortest digit sequence that reads back as the same double,
  formatted exactly as JavaScript's `Number::toString`.
- `atofSpan(src, start, end)` — the double nearest a decimal, ties to even.
  Correctly rounded for every input.

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

`src/bigint.wac` is the arithmetic: fixed-size unsigned, `u32` limbs with `u64`
intermediates. Deliberately not a general bignum — the algorithm needs compare,
subtract, multiply by a small constant and shift left, and finds each digit by
trial subtraction, so there is no division and no Big×Big multiply.

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

`tools/sweep.ts` runs the same comparison over 500 000 doubles when a change wants
more than the suite gives — it takes about seven seconds and currently reports zero
mismatches.

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

## Not here yet

- `itoa`. `wactest` has one; it belongs here, but moving it is that package's call.
- `f32`, in either direction. The algorithms are the same with different constants.
- Fixed-precision output (`toFixed`-style). Only shortest is implemented.
