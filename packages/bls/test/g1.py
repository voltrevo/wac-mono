#!/usr/bin/env python3
"""G1 points and compressed encodings, from affine arithmetic in plain Python.

    python3 packages/bls/test/g1.py > packages/bls/test/g1.json

Affine coordinates with `pow(x, -1, p)` for inversion, against an implementation in Jacobian
coordinates over Montgomery-form limbs. Neither the coordinate system nor the field
representation is shared, so a carry bug or a wrong doubling formula cannot be present in both.

The refusals are the more valuable half. Each is a 48-byte string that a careless reader turns
into a valid point, and therefore a signature that verifies when it must not.
"""
import json
import random

P = 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab
R = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001
GX = 0x17f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb
GY = 0x08b3f481e3aaa0f1a09e30ed741d8ae4fcf5e095d5d00af600db18cb2c04b3edd03cc744a2888ae40caa232946c5e7e1
G = (GX, GY)


def add(p, q):
    """Affine addition; `None` is the point at infinity."""
    if p is None:
        return q
    if q is None:
        return p
    (x1, y1), (x2, y2) = p, q
    if x1 == x2 and (y1 + y2) % P == 0:
        return None
    if p == q:
        m = (3 * x1 * x1 % P) * pow(2 * y1 % P, -1, P) % P
    else:
        m = (y2 - y1) % P * pow((x2 - x1) % P, -1, P) % P
    x3 = (m * m - x1 - x2) % P
    return (x3, (m * (x1 - x3) - y1) % P)


def mul(p, k):
    acc, b = None, p
    while k:
        if k & 1:
            acc = add(acc, b)
        b = add(b, b)
        k >>= 1
    return acc


def compress(p):
    """48 bytes: x big-endian, 0x80 compressed, 0x40 infinity, 0x20 the larger root of y."""
    if p is None:
        b = bytearray(48)
        b[0] = 0xC0
        return b.hex()
    x, y = p
    b = bytearray(x.to_bytes(48, "big"))
    b[0] |= 0x80
    if y > (P - 1) // 2:
        b[0] |= 0x20
    return b.hex()


def main() -> None:
    random.seed(7)
    pts = [None, G, add(G, G), mul(G, 3), mul(G, R - 1)]
    pts += [mul(G, random.randrange(1, R)) for _ in range(6)]
    good = [{"hex": compress(p),
             "x": None if p is None else f"{p[0]:096x}",
             "y": None if p is None else f"{p[1]:096x}"} for p in pts]

    def flip(h, i, m):
        b = bytearray.fromhex(h)
        b[i] ^= m
        return b.hex()

    g = compress(G)
    inf = compress(None)
    bad = [
        {"why": "compression flag clear", "hex": flip(g, 0, 0x80)},
        {"why": "infinity flag set with a non-zero x", "hex": flip(g, 0, 0x40)},
        {"why": "sign flag set on the infinity encoding", "hex": flip(inf, 0, 0x20)},
        {"why": "infinity encoding with a non-zero trailing byte", "hex": inf[:-2] + "01"},
    ]
    for label, value in [("x equal to p", P), ("x above p", P + 1)]:
        b = bytearray(value.to_bytes(48, "big"))
        b[0] |= 0x80
        bad.append({"why": label, "hex": b.hex()})
    # x³ + 4 is a non-square for about half of all x, so such an x is simply not on the curve.
    for cand in range(2, 400):
        if pow((cand ** 3 + 4) % P, (P - 1) // 2, P) != 1:
            b = bytearray(cand.to_bytes(48, "big"))
            b[0] |= 0x80
            bad.append({"why": f"x={cand} is not on the curve", "hex": b.hex()})
            break

    print(json.dumps({"good": good, "bad": bad}, indent=0))


if __name__ == "__main__":
    main()
