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

    print(json.dumps({"p": h(P), "one": h(1), "cases": cases, "unary": unary, "bad": bad,
                      "inv": inv, "roots": roots, "fp2": fp2}, indent=0))


if __name__ == "__main__":
    main()
