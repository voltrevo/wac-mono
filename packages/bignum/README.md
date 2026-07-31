# bignum

Arbitrary-precision integers. Sign-magnitude, `u32` limbs, semantics identical to
JavaScript's `BigInt`.

```wac
import { Big, add, mul, divmod, DivMod } from "../../bignum/src/big.wac";
import { parseDecimal, toStr } from "../../bignum/src/text.wac";

Big a = parseDecimal("123456789012345678901234567890".toBytes())!;
Big b = Big.fromI64(-97);

string sum = toStr(add(a, b));
DivMod d = divmod(a, b);       // d.q truncates toward zero, d.r takes a's sign
```

## Why it is a package

Because `BigInt` is an exact oracle. Every operation here can be compared against a
known-right answer for any input, so correctness is decidable rather than argued — which
is the property that makes a package worth writing when the goal is to find out what the
language does badly.

It also needs no growable container. Every result size is known before the work starts:
an addition is at most `max(n,m)+1` limbs, a product is exactly `n+m`, a quotient is
`n-m+1` and a remainder is `m`. So this is the one non-trivial data structure in the repo
that the absence of generics costs nothing — worth noting, since four other packages carry
a hand-written `push`/grow loop that differs from its neighbours only in element type.

## Semantics

Matched to `BigInt` deliberately, including the parts that are easy to get wrong:

- **Division truncates toward zero** and the remainder takes the sign of the *dividend*.
  `-7 / 2` is `-3` remainder `-1`, not `-4` remainder `1`.
- **`shr` is arithmetic**, so it floors: `-5 >> 1` is `-3`, and `-1 >> 100` is still `-1`.
  Sign-magnitude has to work against itself here — the magnitude shift rounds toward zero,
  so one is subtracted back whenever a set bit was discarded.
- **Zero has one spelling.** `neg` is false whenever `n` is 0, restored by every operation.
  Comparison depends on it, so `-0` and `0` compare equal and print the same.

`divSmall` is the one deliberate departure: its remainder is an unsigned magnitude, because
its only callers are the text conversions and they divide magnitudes.

## Shape

**Free functions, not methods.** `add(a, b)`, not `a.add(b)`. This is forced, not
preferred: wac's deep-const rule makes the method form impossible to write. A `const this`
method cannot use a value returned by another `const this` method — even one that was
freshly allocated — because the result of a call through a const receiver is itself const.
So `Big negate(const this) { Big r = this.copy(); r.neg = ...; }` is rejected, and there is
no spelling of it that is both const-correct and able to build a new value. Dropping
`const` would work and would be a lie. Recorded in the friction log rather than as an
issue, since it is a language design question and not a defect.

**Named `Big`, and `fmt`'s is `FixedBig`.** They used to both be `Big`, which compiles to
invalid wasm rather than to an error — `wac/issues/0036`. `fmt`'s is a fixed-size,
division-free specialisation for float formatting and is deliberately not built on this
one: it must not allocate on its hot path, and every operation here allocates.

**Text works nine digits at a time.** 10^9 is the largest power of ten in a `u32`, so a
decimal chunk costs one `mulSmall` in and one `divSmall` out rather than nine of each.

## Tests

`BigInt` is the oracle throughout, and the generators are aimed at where bignums actually
break rather than spread evenly:

| file | what it pins |
|---|---|
| `test/text.test.ts` | the decimal and hex conversions, **first** — every other test exchanges decimal strings, so a bug here would be blamed on arithmetic |
| `test/arith.test.ts` | add, sub, mul, divmod, shifts, comparison, against `BigInt` |
| `test/u64.test.ts` | that wac's `u64` is unsigned at all — division above 2^63, `>>` not sign-extending, `as@ u32` truncating |
| `test/wac/big_test.wac` | that the package is usable from wac, including `toStr`, which returns a `string` and so cannot be called from the host |

`deno task coverage:bignum` reports 100% of branch points.

### The bug that justifies the generators

One real defect, in `divmod`. When the first quotient-digit estimate comes out at exactly
`base` it is clamped to `base-1`, and the recomputed `rhat` can then be exactly `base`. The
refinement test forms `base*rhat`, which at that point is 2^64 and wraps a `u64` to zero —
so the comparison ran against nothing and talked a correct digit down by one, losing 2^32
from the quotient. Knuth's condition is `while rhat < b && ...`; checking `rhat >= base`
after the increment instead of before skips the guard exactly on the clamp path.

Reaching it needs a divisor whose top limb is `0xffffffff` and a remainder window just
above it. Four hundred random operand pairs across 400-bit sizes never did. The generator
that did was the one producing runs of all-ones and all-zeros limbs, which random digits
essentially never produce — so that family stays in both the tests and `cov.ts`.

Two things were worth more than reading the code, which did not find it:

- `tools/validate.ts` and `test/u64.test.ts`, to rule the compiler out first. A wrong
  answer in limb arithmetic looks exactly like a `u64` opcode being signed.
- `tools/shrink.ts`, which reduces a failing pair to the smallest operands that still
  disagree. It cut a 256-bit dividend to seven limbs in one run and made the trace
  readable.

## Not here yet

- **Karatsuba.** `mul` is schoolbook, O(n·m). Karatsuba wins above a few hundred limbs and
  is an isolated change; nothing here approaches that size.
- **`pow`, `gcd`, `modPow`, `sqrt`.** All straightforward on top of what exists. `modPow`
  is the one with a real design question, since a constant-time version is a different
  algorithm and `crypto` is where that would matter.
- **Bitwise `and`/`or`/`xor`/`not`.** These want two's complement, which sign-magnitude
  makes awkward for negative operands. Doable, and worth doing only when something needs
  them.
- **Parsing other bases.** Decimal and hex only. Base 2 and 8 are the same loop with a
  different chunk size.
