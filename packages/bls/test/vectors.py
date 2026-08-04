#!/usr/bin/env python3
"""Expected values for the BLS12-381 tests, from Python's own integers.

    python3 packages/bls/test/vectors.py > packages/bls/test/vectors.json

The point of this file is that it shares nothing with the implementation it checks. Montgomery
form passes `a·1 == a` and `a + 0 == a` with a completely broken reduction, so a self-relation
proves almost nothing; these values come from `int` arithmetic and `%`.

Deterministic: the seed is fixed, so regenerating without changing this file changes no vector.
"""
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tower import (P as TP, f2mul, f6mul, f6sqr, f6inv, f6mulByV, f12mul, f12sqr, f12inv,
                   f12conj, f12frob, f6frob, F12_ONE)

P = 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab


def h(x: int) -> str:
    """A field element as 48 big-endian bytes in hex — the wire encoding."""
    return f"{x:096x}"


def main() -> None:
    random.seed(20260804)
    # Chosen edges first: the identities, both ends of the range, the halfway point, a value
    # that fits in one limb, one that only touches the top limb, and p−1 written out.
    vals = [
        0, 1, 2, P - 1, P - 2, (P - 1) // 2, 0xffffffff, 1 << 380,
        P - 1,
    ]
    vals += [random.randrange(P) for _ in range(24)]

    cases = [
        {"a": h(a), "b": h(b), "add": h((a + b) % P), "sub": h((a - b) % P), "mul": h(a * b % P)}
        for a in vals for b in vals[:14]
    ]
    unary = [{"a": h(a), "neg": h((-a) % P), "sq": h(a * a % P)} for a in vals]
    # Every one of these is a valid 48-byte string and an invalid field element.
    bad = [h(P), h(P + 1), h((1 << 384) - 1), h(P + 12345)]

    # Inversion and square roots. `sqrt` is None where the value is not a square, which is
    # roughly half of them — and the implementation must say so rather than return a non-root,
    # because point decompression feeds it attacker-controlled bytes.
    inv = [{"a": h(a), "inv": h(pow(a, -1, P))} for a in vals if a != 0]
    roots = []
    for a in vals:
        r = pow(a, (P + 1) // 4, P)
        roots.append({"a": h(a), "sqrt": h(r) if r * r % P == a else None})

    # Fp2 = Fp[u]/(u²+1). Coefficients as (c0, c1), so a = c0 + c1·u.
    def f2mul(x, y):
        return ((x[0] * y[0] - x[1] * y[1]) % P, (x[0] * y[1] + x[1] * y[0]) % P)

    def f2(x):
        return {"c0": h(x[0]), "c1": h(x[1])}

    pairs = [(vals[i], vals[(i * 7 + 3) % len(vals)]) for i in range(len(vals))]
    fp2 = []
    for i in range(len(pairs)):
        a = pairs[i]
        b = pairs[(i * 5 + 1) % len(pairs)]
        # ξ = 1 + u, the non-residue that builds Fp6 over Fp2.
        xi = f2mul(a, (1, 1))
        fp2.append({
            "a": f2(a), "b": f2(b),
            "add": f2(((a[0] + b[0]) % P, (a[1] + b[1]) % P)),
            "sub": f2(((a[0] - b[0]) % P, (a[1] - b[1]) % P)),
            "mul": f2(f2mul(a, b)),
            "sq": f2(f2mul(a, a)),
            "conj": f2((a[0], (-a[1]) % P)),
            "mulByU": f2(f2mul(a, (0, 1))),
            "mulByXi": f2(xi),
            "norm": h((a[0] * a[0] + a[1] * a[1]) % P),
        })

    # ── The tower ─────────────────────────────────────────────────────────────
    # Fp6 and Fp12 elements are flattened to lists of coefficient hex, in the same order the
    # probe reads and writes them: c0 then c1 within each Fp2, ascending degree above that.
    def r2():
        return (random.randrange(P), random.randrange(P))

    def flat6(x):
        return [h(c) for pair in x for c in pair]

    def flat12(x):
        return flat6(x[0]) + flat6(x[1])

    def rnd6():
        return tuple(r2() for _ in range(3))

    def rnd12():
        return (rnd6(), rnd6())

    fp6 = []
    for _ in range(8):
        a, b = rnd6(), rnd6()
        fp6.append({"a": flat6(a), "b": flat6(b), "mul": flat6(f6mul(a, b)),
                    "sq": flat6(f6sqr(a)), "mulByV": flat6(f6mulByV(a)),
                    "inv": flat6(f6inv(a)), "frob1": flat6(f6frob(a, 1)),
                    "frob2": flat6(f6frob(a, 2)), "frob3": flat6(f6frob(a, 3))})

    fp12 = []
    for _ in range(8):
        a, b = rnd12(), rnd12()
        fp12.append({"a": flat12(a), "b": flat12(b), "mul": flat12(f12mul(a, b)),
                     "sq": flat12(f12sqr(a)), "conj": flat12(f12conj(a)),
                     "inv": flat12(f12inv(a)), "frob1": flat12(f12frob(a, 1)),
                     "frob2": flat12(f12frob(a, 2)), "frob3": flat12(f12frob(a, 3))})

    print(json.dumps({"p": h(P), "one": h(1), "cases": cases, "unary": unary, "bad": bad,
                      "inv": inv, "roots": roots, "fp2": fp2, "fp6": fp6, "fp12": fp12},
                     indent=0))


if __name__ == "__main__":
    main()
