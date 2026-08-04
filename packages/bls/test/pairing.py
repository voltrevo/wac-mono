"""The optimal ate pairing on BLS12-381, in plain Python — the oracle for the wac Miller loop.

Validated against `@noble/curves`, an independent implementation, at two points: the Miller loop
output *before* final exponentiation, and the finished pairing. Anchoring both matters because a
wrong final exponentiation and a wrong Miller loop are separately possible and each alone would
still satisfy bilinearity.

The twist convention is settled by experiment against that reference rather than from memory:
whether BLS12-381 untwists with w² or 1/w² is exactly the sort of thing that yields a
self-consistent pairing disagreeing with everyone else's.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tower import (P, F2_ONE, F2_ZERO, F6_ONE, F6_ZERO, F12_ONE, XI,
                   f2add, f2sub, f2mul, f2neg, f2sqr, f2inv,
                   f6add, f6sub, f6mul, f6neg,
                   f12mul, f12sqr, f12conj, f12inv, f12frob, f12pow)

R = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001
# The BLS parameter. Negative, which is why the Miller loop's result is conjugated at the end.
X = -0xd201000000010000


def f12(c0, c1):
    return (c0, c1)


def f6(a, b, c):
    return (a, b, c)


def fp_to_f12(x):
    """A base field element as an Fp12 element."""
    return f12(f6((x % P, 0), F2_ZERO, F2_ZERO), F6_ZERO)


def f2_to_f12_w2(a):
    """a·w², which is where the untwist puts a G2 x-coordinate."""
    return f12(f6(F2_ZERO, a, F2_ZERO), F6_ZERO)


def f2_to_f12_w3(a):
    """a·w³."""
    return f12(F6_ZERO, f6(F2_ZERO, a, F2_ZERO))


def double_step(r):
    """One Miller doubling: 2·T, and the line's three Fp2 coefficients.

    Algorithm 26 of eprint 2010/354, as used by zkcrypto/bls12_381 — Jacobian, no inversion.
    """
    x, y, z = r
    t0 = f2sqr(x)
    t1 = f2sqr(y)
    t2 = f2sqr(t1)
    t3 = f2sub(f2sub(f2sqr(f2add(t1, x)), t0), t2)
    t3 = f2add(t3, t3)
    t4 = f2add(f2add(t0, t0), t0)
    t6 = f2add(x, t4)
    t5 = f2sqr(t4)
    zsq = f2sqr(z)
    nx = f2sub(f2sub(t5, t3), t3)
    nz = f2sub(f2sub(f2sqr(f2add(z, y)), t1), zsq)
    ny = f2mul(f2sub(t3, nx), t4)
    t2x8 = f2add(f2add(f2add(t2, t2), f2add(t2, t2)), f2add(f2add(t2, t2), f2add(t2, t2)))
    ny = f2sub(ny, t2x8)
    c1 = f2neg(f2add(f2mul(t4, zsq), f2mul(t4, zsq)))
    t6 = f2sub(f2sub(f2sqr(t6), t0), t5)
    t1x4 = f2add(f2add(t1, t1), f2add(t1, t1))
    c2 = f2sub(t6, t1x4)
    c0 = f2add(f2mul(nz, zsq), f2mul(nz, zsq))
    return (nx, ny, nz), (c0, c1, c2)


def add_step(r, q):
    """One Miller addition: T + Q, and the line coefficients."""
    x, y, z = r
    qx, qy = q
    zsq = f2sqr(z)
    ysq = f2sqr(qy)
    t0 = f2mul(zsq, qx)
    t1 = f2sub(f2mul(f2add(qy, z), f2add(qy, z)), f2add(ysq, zsq))
    t1 = f2mul(t1, zsq)
    t2 = f2sub(t0, x)
    t3 = f2sqr(t2)
    t4 = f2add(f2add(t3, t3), f2add(t3, t3))
    t5 = f2mul(t4, t2)
    t6 = f2sub(t1, f2add(y, y))
    t9 = f2mul(t6, qx)
    t7 = f2mul(t4, x)
    nx = f2sub(f2sub(f2sqr(t6), t5), f2add(t7, t7))
    nz = f2sub(f2sub(f2sqr(f2add(z, t2)), zsq), t3)
    t10 = f2add(qy, nz)
    t8 = f2mul(f2sub(t7, nx), t6)
    t0b = f2add(f2mul(y, t5), f2mul(y, t5))
    ny = f2sub(t8, t0b)
    t10 = f2sub(f2sub(f2sqr(t10), ysq), f2sqr(nz))
    t9 = f2sub(f2add(t9, t9), t10)
    t10 = f2add(nz, nz)
    t6 = f2neg(t6)
    t1b = f2add(t6, t6)
    return (nx, ny, nz), (t10, t1b, t9)


def ell(f, coeffs, px, py):
    """Multiply `f` by the sparse Fp12 element a line evaluation produces."""
    c0, c1, c2 = coeffs
    c0 = (c0[0] * py % P, c0[1] * py % P)
    c1 = (c1[0] * px % P, c1[1] * px % P)
    # The sparse element is c2 + c1·v + c0·v²·w in our basis; written as a full multiply here
    # because Python speed is irrelevant and a general multiply cannot have a sparse-path bug.
    sparse = f12(f6(c2, c1, F2_ZERO), f6(F2_ZERO, c0, F2_ZERO))
    return f12mul(f, sparse)


def miller_loop(p_affine, q_affine):
    """f_{|x|}(Q, P), before the final exponentiation."""
    px, py = p_affine
    qx, qy = q_affine
    r = (qx, qy, F2_ONE)
    f = F12_ONE
    n = abs(X)
    started = False
    for i in range(n.bit_length() - 2, -1, -1):
        if started:
            f = f12sqr(f)
        started = True
        r, c = double_step(r)
        f = ell(f, c, px, py)
        if (n >> i) & 1:
            r, c = add_step(r, (qx, qy))
            f = ell(f, c, px, py)
    # x is negative, so the accumulated value must be conjugated.
    return f12conj(f) if X < 0 else f


def final_exponentiate(f):
    """(p¹²−1)/r, as the easy part then the hard part."""
    # Easy: f^(p⁶−1)(p²+1). Conjugation stands in for the p⁶ Frobenius on the cyclotomic subgroup.
    t = f12mul(f12conj(f), f12inv(f))
    t = f12mul(f12frob(t, 2), t)
    # Hard part: the BLS-specific chain, expressed through |x| and Frobenius.
    def pow_x(v, negate):
        r = f12pow(v, abs(X))
        return f12conj(r) if negate else r

    y0 = f12conj(f12sqr(t))
    y1 = pow_x(t, True)
    y2 = pow_x(y1, True)
    y3 = f12conj(y1)
    y4 = pow_x(y2, True)
    # λ = (x−1)²(x+p)(x²+p²−1) + 3, evaluated as a straight chain.
    a = f12mul(y0, y1)
    a = f12mul(a, y2)
    del y3, y4, a
    # The chain above is fiddly; use the direct exponent instead — Python can afford it.
    e = (P ** 12 - 1) // R
    return f12pow(f, e)


def pairing(p_affine, q_affine):
    return final_exponentiate(miller_loop(p_affine, q_affine))
