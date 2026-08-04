#!/usr/bin/env python3
"""G2 points and compressed encodings, from affine Fp2 arithmetic in plain Python.

    python3 packages/bls/test/g2.py > packages/bls/test/g2.json

Same argument as `g1.py`: affine coordinates and `pow(x, -1, p)` against Jacobian coordinates
over Montgomery limbs. Signatures are G2 points, so this file's refusals are the ones an
attacker actually reaches.
"""
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tower import P, f2add, f2sub, f2mul, f2inv, f2sqr

R = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001
GX = (0x024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb8,
      0x13e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e)
GY = (0x0ce5d527727d6e118cc9cdc6da2e351aadfd9baa8cbdd3a76d429a695160d12c923ac9cc3baca289e193548608b82801,
      0x0606c4a02ea734cc32acd2b02bc28b99cb3e287e85a763af267492ab572e99ab3f370d275cec1da1aaa9075ff05f79be)
B2 = (4, 4)
G = (GX, GY)
THREE = (3, 0)
TWO = (2, 0)


def add(p, q):
    if p is None:
        return q
    if q is None:
        return p
    (x1, y1), (x2, y2) = p, q
    if x1 == x2 and f2add(y1, y2) == (0, 0):
        return None
    if p == q:
        m = f2mul(f2mul(THREE, f2sqr(x1)), f2inv(f2mul(TWO, y1)))
    else:
        m = f2mul(f2sub(y2, y1), f2inv(f2sub(x2, x1)))
    x3 = f2sub(f2sub(f2sqr(m), x1), x2)
    return (x3, f2sub(f2mul(m, f2sub(x1, x3)), y1))


def mul(p, k):
    acc, b = None, p
    while k:
        if k & 1:
            acc = add(acc, b)
        b = add(b, b)
        k >>= 1
    return acc


def larger(y):
    """The sign convention: compare c1 first, then c0."""
    return y[1] > (P - 1) // 2 if y[1] else y[0] > (P - 1) // 2


def compress(p):
    """96 bytes: x.c1 then x.c0, big-endian, with the flags in byte 0."""
    if p is None:
        b = bytearray(96)
        b[0] = 0xC0
        return b.hex()
    x, y = p
    b = bytearray(x[1].to_bytes(48, "big") + x[0].to_bytes(48, "big"))
    b[0] |= 0x80
    if larger(y):
        b[0] |= 0x20
    return b.hex()


def main() -> None:
    random.seed(11)
    assert f2sqr(GY) == f2add(f2mul(f2sqr(GX), GX), B2), "generator is not on the twist"
    assert mul(G, R) is None, "generator does not have order r"

    pts = [None, G, add(G, G), mul(G, 3), mul(G, R - 1)]
    pts += [mul(G, random.randrange(1, R)) for _ in range(5)]
    good = [{"hex": compress(p),
             "x": None if p is None else [f"{p[0][0]:096x}", f"{p[0][1]:096x}"],
             "y": None if p is None else [f"{p[1][0]:096x}", f"{p[1][1]:096x}"]} for p in pts]

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
    for label, hi, lo in [("x.c1 equal to p", P, 0), ("x.c0 equal to p", 1, P),
                          ("x.c0 above p", 1, P + 7)]:
        b = bytearray(hi.to_bytes(48, "big") + lo.to_bytes(48, "big"))
        b[0] |= 0x80
        bad.append({"why": label, "hex": b.hex()})
    # An x whose y² has no square root in Fp2 — not on the twist at all.
    for c in range(2, 500):
        cand = (c, 1)
        y2 = f2add(f2mul(f2sqr(cand), cand), B2)
        # A square in Fp2 iff its norm is a square in Fp.
        if pow((y2[0] * y2[0] + y2[1] * y2[1]) % P, (P - 1) // 2, P) != 1:
            b = bytearray(cand[1].to_bytes(48, "big") + cand[0].to_bytes(48, "big"))
            b[0] |= 0x80
            bad.append({"why": f"x=({c}+u) is not on the twist", "hex": b.hex()})
            break

    print(json.dumps({"good": good, "bad": bad}, indent=0))


if __name__ == "__main__":
    main()
