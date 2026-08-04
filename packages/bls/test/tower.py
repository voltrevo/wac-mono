"""The BLS12-381 field tower in plain Python integers — the oracle for fp2/fp6/fp12.

No Montgomery form, no limbs, no carries: everything is `int` and `%`. That is the point. The
implementation under test holds twelve 32-bit limbs in Montgomery form, so a bug in its
representation cannot also be a bug here.

    Fp2  = Fp[u]/(u² + 1)
    Fp6  = Fp2[v]/(v³ − ξ),  ξ = 1 + u
    Fp12 = Fp6[w]/(w² − v)
"""

P = 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab

# ── Fp2, as a pair (c0, c1) meaning c0 + c1·u ─────────────────────────────────
def f2add(a, b): return ((a[0] + b[0]) % P, (a[1] + b[1]) % P)
def f2sub(a, b): return ((a[0] - b[0]) % P, (a[1] - b[1]) % P)
def f2neg(a): return ((-a[0]) % P, (-a[1]) % P)
def f2conj(a): return (a[0], (-a[1]) % P)
def f2mul(a, b): return ((a[0] * b[0] - a[1] * b[1]) % P, (a[0] * b[1] + a[1] * b[0]) % P)
def f2sqr(a): return f2mul(a, a)
def f2scale(a, k): return (a[0] * k % P, a[1] * k % P)
F2_ZERO, F2_ONE, XI = (0, 0), (1, 0), (1, 1)

def f2inv(a):
    n = pow((a[0] * a[0] + a[1] * a[1]) % P, -1, P)
    return (a[0] * n % P, (-a[1]) * n % P)

def f2pow(a, e):
    r, b = F2_ONE, a
    while e:
        if e & 1: r = f2mul(r, b)
        b = f2sqr(b); e >>= 1
    return r

# ── Fp6, as (c0, c1, c2) meaning c0 + c1·v + c2·v² ────────────────────────────
def f6add(a, b): return tuple(f2add(x, y) for x, y in zip(a, b))
def f6sub(a, b): return tuple(f2sub(x, y) for x, y in zip(a, b))
def f6neg(a): return tuple(f2neg(x) for x in a)
F6_ZERO = (F2_ZERO,) * 3
F6_ONE = (F2_ONE, F2_ZERO, F2_ZERO)

def f6mul(a, b):
    t0, t1, t2 = f2mul(a[0], b[0]), f2mul(a[1], b[1]), f2mul(a[2], b[2])
    c0 = f2add(t0, f2mul(XI, f2sub(f2sub(f2mul(f2add(a[1], a[2]), f2add(b[1], b[2])), t1), t2)))
    c1 = f2add(f2sub(f2sub(f2mul(f2add(a[0], a[1]), f2add(b[0], b[1])), t0), t1), f2mul(XI, t2))
    c2 = f2add(f2sub(f2sub(f2mul(f2add(a[0], a[2]), f2add(b[0], b[2])), t0), t2), t1)
    return (c0, c1, c2)

def f6sqr(a): return f6mul(a, a)

def f6mulByV(a):
    """a·v — the multiplication that folds v³ back to ξ."""
    return (f2mul(XI, a[2]), a[0], a[1])

def f6inv(a):
    t0 = f2sub(f2sqr(a[0]), f2mul(XI, f2mul(a[1], a[2])))
    t1 = f2sub(f2mul(XI, f2sqr(a[2])), f2mul(a[0], a[1]))
    t2 = f2sub(f2sqr(a[1]), f2mul(a[0], a[2]))
    d = f2add(f2mul(a[0], t0), f2mul(XI, f2add(f2mul(a[2], t1), f2mul(a[1], t2))))
    n = f2inv(d)
    return (f2mul(t0, n), f2mul(t1, n), f2mul(t2, n))

# ── Fp12, as (c0, c1) meaning c0 + c1·w ──────────────────────────────────────
F12_ONE = (F6_ONE, F6_ZERO)
def f12mul(a, b):
    t0, t1 = f6mul(a[0], b[0]), f6mul(a[1], b[1])
    c0 = f6add(t0, f6mulByV(t1))
    c1 = f6sub(f6sub(f6mul(f6add(a[0], a[1]), f6add(b[0], b[1])), t0), t1)
    return (c0, c1)

def f12sqr(a): return f12mul(a, a)
def f12conj(a): return (a[0], f6neg(a[1]))

def f12inv(a):
    t = f6inv(f6sub(f6sqr(a[0]), f6mulByV(f6sqr(a[1]))))
    return (f6mul(a[0], t), f6neg(f6mul(a[1], t)))

def f12pow(a, e):
    r, b = F12_ONE, a
    while e:
        if e & 1: r = f12mul(r, b)
        b = f12sqr(b); e >>= 1
    return r

# ── Frobenius, from constants — and validated against actual exponentiation ───
# ξ^((p^i−1)/3) and ξ^((2(p^i−1))/3) for Fp6; ξ^((p^i−1)/6) for Fp12.
FROB6_C1 = [f2pow(XI, (P**i - 1) // 3) for i in range(6)]
FROB6_C2 = [f2pow(XI, (2 * (P**i - 1)) // 3) for i in range(6)]
FROB12_C1 = [f2pow(XI, (P**i - 1) // 6) for i in range(12)]

def f2frob(a, n):
    """The p^n-power map on Fp2: conjugation when n is odd, identity when even."""
    return f2conj(a) if n % 2 else a

def f6frob(a, n):
    return (f2frob(a[0], n), f2mul(f2frob(a[1], n), FROB6_C1[n % 6]),
            f2mul(f2frob(a[2], n), FROB6_C2[n % 6]))

def f12frob(a, n):
    return (f6frob(a[0], n), tuple(f2mul(x, FROB12_C1[n % 12]) for x in f6frob(a[1], n)))
