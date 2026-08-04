#!/usr/bin/env python3
"""A rejected experiment, kept because the result is worth not repeating.

    python3 packages/bls/tools/genfips-experiment.py wac   > packages/bls/test/wac/fips.wac
    python3 packages/bls/tools/genfips-experiment.py cases > cases.json

Generates a FIPS Montgomery multiply on fourteen 29-bit limbs, to time against `src/fpkernel.wac`'s
CIOS on twelve 32-bit limbs. The emitted file is *not* checked in; run this to recreate it.

## The idea, and why it looked good

CIOS normalises its carry after every one of 288 multiply-accumulate steps, because a 32-bit product
fills a u64 and leaves no room to defer. Narrower limbs leave headroom, which licenses product
scanning: accumulate a whole column, normalise once. FIPS (Finely Integrated Product Scanning, Koc,
Acar and Kaliski) folds the Montgomery reduction into the same column sweep.

    32-bit CIOS   12 limbs   288 products x ~5 ops                 = 1440
    29-bit FIPS   14 limbs   392 products x ~2 ops + 28 cols x ~5   =  ~900   (38% fewer)

## What it measured, 2026-08-04

    CIOS  12 x 32-bit, 288 products, ~1440 ops   114 ns
    FIPS  14 x 29-bit, 392 products,  ~900 ops   179 ns    56% SLOWER

**38% fewer operations, 56% more time.** Correctness is not the explanation: the emitted code agrees
with 576 vectors whose expected values were cross-checked against plain Python integer arithmetic,
not against this implementation.

Three explanations were tested and two are disproved:

- **Register pressure** — no. The FIPS variant holds 57 live `u64` locals against CIOS's ~30, but a
  variant reading `a` and `b` from arrays instead (29 locals) runs the same: 177 ns against 179.
- **Multiply throughput** — no. An `i64` multiply measures 0.087 ns standalone, so FIPS's extra 104
  multiplies are about 9 ns, and all 288 of CIOS's are 25 ns of its 114. Multiply is only ~1.4x the
  cost of an add here.
- **The single serial accumulator** — FIPS funnels all 392 products through one `acc` while CIOS
  spreads accumulation across twelve independent `t_j` and serialises only the carry. This is the
  remaining candidate and it is **not established**: the microbenchmark written for it was invalid,
  reporting a dependent add chain as *faster* than an independent one because the engine folded
  `a+k` eight times into `a+8k`.

So the *why* is open and the *what* is settled. Do not re-derive the op-count argument and expect a
win; it has been tried.

## One finding that outlived the experiment

**30-bit limbs would be faster — thirteen limbs rather than fourteen — and can silently overflow.**
A column accumulates up to 2N products, and the rigorous bound over a_i, b_j, m_i <= 2^W-1 with p's
real limbs is **2^64.304** for W=30: it does not fit in u64. Sampling says otherwise — 43 random
pairs *including (p-1)^2* peaked at 2^63.1. Random vectors would have shipped that. W=29 bounds at
2^62.394, 1.6 bits of headroom, proved rather than sampled.

That is the same fault class as everything else this package has nearly got wrong: correct for
almost every input, wrong for a set no test will generate.
"""
import json
import random
import sys

P = 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab
W = 29
N = 14
MASK = (1 << W) - 1
R = 1 << (W * N)
INV = (-pow(P, -1, 1 << W)) % (1 << W)
PL = [(P >> (W * i)) & MASK for i in range(N)]

assert N * W >= P.bit_length()
assert (P * INV) % (1 << W) == (1 << W) - 1


def to_limbs(x):
    return [(x >> (W * i)) & MASK for i in range(N)]


def from_limbs(v):
    return sum(int(w) << (W * i) for i, w in enumerate(v))


def fips(a, b):
    """The reference, matching the emitted wac statement for statement."""
    m = [0] * N
    acc = 0
    t = [0] * (N + 1)
    for k in range(N):
        for i in range(k):
            acc += a[i] * b[k - i]
            acc += m[i] * PL[k - i]
        acc += a[k] * b[0]
        m[k] = ((acc & MASK) * INV) & MASK
        acc += m[k] * PL[0]
        acc >>= W
    for k in range(N):
        for i in range(k + 1, N):
            acc += a[i] * b[N + k - i]
            acc += m[i] * PL[N + k - i]
        t[k] = acc & MASK
        acc >>= W
    t[N] = acc
    out = t[:N]
    if t[N] != 0 or from_limbs(out) >= P:
        borrow = 0
        for i in range(N):
            d = out[i] - PL[i] - borrow
            out[i] = d & MASK
            borrow = 1 if d < 0 else 0
    return out


def emit_variant(name, a_local, b_local):
    """The same FIPS, with a and/or b read from the array instead of held in locals."""
    A = (lambda i: f"a{i}") if a_local else (lambda i: f"(a[{i}] as u64)")
    B = (lambda i: f"b{i}") if b_local else (lambda i: f"(b[{i}] as u64)")
    L = [f"export u32[] {name}(u32[] a, u32[] b) {{"]
    if a_local:
        L += [f"  u64 a{i} = a[{i}] as u64;" for i in range(N)]
    if b_local:
        L += [f"  u64 b{i} = b[{i}] as u64;" for i in range(N)]
    L += [f"  u64 m{i} = 0;" for i in range(N)]
    L += [f"  u64 t{i} = 0;" for i in range(N)]
    L.append("  u64 acc = 0;")
    L.append("  u64 top = 0;")
    for k in range(N):
        for i in range(k):
            L.append(f"  acc = acc + {A(i)} * {B(k - i)};")
            L.append(f"  acc = acc + m{i} * 0x{PL[k - i]:08x};")
        L.append(f"  acc = acc + {A(k)} * {B(0)};")
        L.append(f"  m{k} = ((acc & FMASK) * FINV) & FMASK;")
        L.append(f"  acc = acc + m{k} * 0x{PL[0]:08x};")
        L.append(f"  acc = acc >> {W};")
    for k in range(N):
        for i in range(k + 1, N):
            L.append(f"  acc = acc + {A(i)} * {B(N + k - i)};")
            L.append(f"  acc = acc + m{i} * 0x{PL[N + k - i]:08x};")
        L.append(f"  t{k} = acc & FMASK;")
        L.append(f"  acc = acc >> {W};")
    L.append("  top = acc;")
    L.append("  u32[] out = u32[%d]();" % N)
    L += [f"  out[{i}] = t{i} as@ u32;" for i in range(N)]
    L.append("  if (top != 0 || fipsAtLeastP(out)) { fipsSubP(out); }")
    L.append("  return out;")
    L.append("}")
    return "\n".join(L)


def emit_wac():
    L = []
    L.append(f"""// GENERATED by scratchpad/genfips.py — an experiment, not part of the package.
//
// FIPS Montgomery multiplication on {N} limbs of {W} bits, against `src/fpkernel.wac`'s CIOS on
// twelve 32-bit limbs. Both compute a*b*R^-1 mod p; the R differs, which does not matter for timing
// a chain of multiplies, and `fips_wac.test.ts` checks this one against Python-generated vectors.
//
// The point is the operation count. CIOS normalises its carry after every one of 288
// multiply-accumulate steps because a 32-bit product fills a u64. {W}-bit limbs leave headroom, so a
// whole column of products accumulates before one normalisation — {2 * N * N} products at about two
// operations each instead of 288 at about five.
//
// Limbs are held one per u32, using the low {W} bits. p as immediates, everything in locals, for the
// same reason `fpkernel.wac` is that way: measured, that was worth 64%.

const u64 FMASK = 0x{MASK:08x};
const u64 FINV  = 0x{INV:08x};
""")

    # --- the multiply ---------------------------------------------------------------------
    L.append("export u32[] fipsMul(u32[] a, u32[] b) {")
    for i in range(N):
        L.append(f"  u64 a{i} = a[{i}] as u64;")
    for i in range(N):
        L.append(f"  u64 b{i} = b[{i}] as u64;")
    for i in range(N):
        L.append(f"  u64 m{i} = 0;")
    for i in range(N):
        L.append(f"  u64 t{i} = 0;")
    L.append("  u64 acc = 0;")
    L.append("  u64 top = 0;")

    L.append("")
    L.append("  // Lower half: each column clears its low limb, which is the reduction.")
    for k in range(N):
        L.append(f"  // column {k}")
        for i in range(k):
            L.append(f"  acc = acc + a{i} * b{k - i};")
            L.append(f"  acc = acc + m{i} * 0x{PL[k - i]:08x};")
        L.append(f"  acc = acc + a{k} * b0;")
        L.append(f"  m{k} = ((acc & FMASK) * FINV) & FMASK;")
        L.append(f"  acc = acc + m{k} * 0x{PL[0]:08x};")
        L.append(f"  acc = acc >> {W};")

    L.append("")
    L.append("  // Upper half: the remaining cross terms, and the result limbs.")
    for k in range(N):
        L.append(f"  // column {N + k}")
        for i in range(k + 1, N):
            L.append(f"  acc = acc + a{i} * b{N + k - i};")
            L.append(f"  acc = acc + m{i} * 0x{PL[N + k - i]:08x};")
        L.append(f"  t{k} = acc & FMASK;")
        L.append(f"  acc = acc >> {W};")
    L.append("  top = acc;")

    L.append("")
    L.append("  u32[] out = u32[%d]();" % N)
    for i in range(N):
        L.append(f"  out[{i}] = t{i} as@ u32;")
    L.append("  if (top != 0 || fipsAtLeastP(out)) { fipsSubP(out); }")
    L.append("  return out;")
    L.append("}")

    # --- reduction helpers ----------------------------------------------------------------
    L.append("")
    L.append("bool fipsAtLeastP(u32[] a) {")
    for i in range(N - 1, -1, -1):
        L.append(f"  if (a[{i}] != 0x{PL[i]:08x}) {{ return (a[{i}] as u64) > 0x{PL[i]:08x}; }}")
    L.append("  return true;")
    L.append("}")
    L.append("")
    L.append("void fipsSubP(u32[] a) {")
    L.append("  i64 borrow = 0;")
    L.append("  i64 d = 0;")
    for i in range(N):
        L.append(f"  d = (a[{i}] as i64) - 0x{PL[i]:08x} - borrow;")
        L.append(f"  a[{i}] = (d & 0x{MASK:08x}) as@ u32;")
        L.append("  borrow = (d < 0) ? 1 : 0;")
    L.append("}")

    # --- drivers, and the shipped one for comparison in the same module -------------------
    L.append('''
import { montMul } from "../../src/fpkernel.wac";

/** A dependent chain, so nothing can be hoisted, in each representation. */
export i32 runFips(u32[] seed, i32 n) {
  u32[] acc = seed;
  for (i32 i = 0; i < n; i++) { acc = fipsMul(acc, seed); }
  return acc[0] as@ i32;
}

export i32 runCios(u32[] seed, i32 n) {
  u32[] acc = seed;
  for (i32 i = 0; i < n; i++) { acc = montMul(acc, seed); }
  return acc[0] as@ i32;
}

/** One multiply, as limbs, for checking against the Python vectors. */
export u32[] fipsOnce(u32[] a, u32[] b) { return fipsMul(a, b); }
''')
    # Fewer live locals, to find out whether register pressure is what costs the FIPS version.
    L.append(emit_variant("fipsMulArr", False, False))
    L.append('''
export i32 runFipsArr(u32[] seed, i32 n) {
  u32[] acc = seed;
  for (i32 i = 0; i < n; i++) { acc = fipsMulArr(acc, seed); }
  return acc[0] as@ i32;
}
export u32[] fipsArrOnce(u32[] a, u32[] b) { return fipsMulArr(a, b); }
''')
    return "\n".join(L) + "\n"


def emit_cases():
    random.seed(11)
    edges = [0, 1, 2, P - 1, P - 2, (P - 1) // 2, 1 << 380, 0xffffffff]
    vals = edges + [random.randrange(P) for _ in range(40)]
    cases = []
    for a in vals:
        for b in vals[:12]:
            cases.append({
                "a": to_limbs(a),
                "b": to_limbs(b),
                "want": fips(to_limbs(a), to_limbs(b)),
            })
    # Cross-check the reference against plain integer arithmetic, so the vectors are not just this
    # implementation agreeing with itself.
    rinv = pow(R, -1, P)
    for c in cases:
        assert from_limbs(c["want"]) == (from_limbs(c["a"]) * from_limbs(c["b"]) * rinv) % P
    seed = to_limbs(random.randrange(P))
    return {"w": W, "n": N, "seed": seed, "cases": cases}


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "wac"
    if what == "wac":
        sys.stdout.write(emit_wac())
    else:
        json.dump(emit_cases(), sys.stdout)
