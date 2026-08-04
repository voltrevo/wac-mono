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

    print(json.dumps({"p": h(P), "one": h(1), "cases": cases, "unary": unary, "bad": bad}, indent=0))


if __name__ == "__main__":
    main()
