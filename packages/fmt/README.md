# fmt

`f64` → decimal string: the shortest digit sequence that reads back as the same
double, formatted exactly as JavaScript's `Number::toString`.

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

## Not here yet

- `itoa`. `wactest` has one; it belongs here, but moving it is that package's call.
- `f32`. The algorithm is the same with different constants.
- Fixed-precision output (`toFixed`-style). Only shortest is implemented.
