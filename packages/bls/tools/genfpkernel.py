#!/usr/bin/env python3
"""Generate `packages/bls/src/fpkernel.wac` — the unrolled Fp arithmetic kernel.

    deno task gen:bls-fpkernel      # or: python3 packages/bls/tools/genfpkernel.py

`test/fpkernel_generated.test.ts` fails if the checked-in file is not what this script produces, so
the generated code cannot drift from the generator.

## Why this is generated rather than written

`src/fp.wac` had all of this as loops over `u32[12]` operands, which is the readable way to write
it and reads almost exactly like the published algorithms. Measured against variants differing
*only* in where the state lives and whether the loop is rolled:

    montMul   loops, p from array (as it was)   316.2 ns   baseline
              loops, p as immediates           210.4 ns   -33.5%
              unrolled, a in locals, t array   120.8 ns   -61.8%
              unrolled, a array, t in locals   112.9 ns   -64.3%
              unrolled, both in locals         112.7 ns   -64.4%

    montAdd   loop 25.9 ns  ->  unrolled 20.7 ns   -20.2%
    montSub   loop 30.3 ns  ->  unrolled 25.1 ns   -17.3%

So roughly two thirds of a field multiplication was loop overhead, bounds checks and array traffic
rather than arithmetic — CIOS does 288 multiply-accumulate steps, and each was also doing two or
three array accesses and a loop test. End to end this took a signature verification from 15.3 ms to
under 9 ms.

## Two things this measurement ruled out

**384-bit Karatsuba.** The obvious next move looked like cutting 144 limb products to about 108.
But a limb addition costs about what a limb multiply-accumulate costs here, and Karatsuba pays
roughly 70 extra additions to save 36 multiplies, so at this size it is a loss. Reducing the
multiplication *count* was never the lever; reducing the work around each multiplication was.

**A dedicated squaring.** `fpSquare` is `fpMul(a, a)`, which computes every off-diagonal product
twice, and a squaring would take the multiply half from 144 steps to 78. Measured by making
`fpSquare` do its work twice and timing a whole verification, all of `fpSquare` is 0.59 ms of 8.65,
so the ceiling on a squaring is about 0.14 ms — 1.6% — for several hundred lines of carry handling
that is exactly where squaring implementations go wrong. Not taken, and worth not re-litigating.

## Why the modulus lives only here

p appears as immediates in every function below, and nowhere else in the package except
`modulus()` in `fp.wac`, which returns it as an array for the one caller that indexes it in a loop
(`fpInvert`'s subtraction). `fp.wac`'s `fpModulusConstantsAgree` checks that array against these
immediates across the file boundary, and `fp_wac.test.ts` runs it. That is the only guard against
two spellings of a 381-bit constant drifting, and drift here is the kind of fault that is correct
for almost every input.

The 32-bit limbs and the CIOS structure come from wasm having no 64x64->128 multiply and no carry
flag: `i64` is the widest multiply available, so 32-bit limbs with a 64-bit accumulator is what
fits.
"""
import pathlib
import sys

# p, least-significant limb first.
P = [0xffffaaab, 0xb9feffff, 0xb153ffff, 0x1eabfffe, 0xf6b0f624, 0x6730d2a0,
     0xf38512bf, 0x64774b84, 0x434bacd7, 0x4b1ba7b6, 0x397fe69a, 0x1a0111ea]
N = 12
INV = 0xfffcfffd          # -p^-1 mod 2^32, the CIOS multiplier

HEADER = """// GENERATED FILE — do not edit. Produced by `packages/bls/tools/genfpkernel.py`.
//
//     deno task gen:bls-fpkernel
//
// The Fp arithmetic kernel: multiplication, addition, subtraction and the reduction helpers, all
// unrolled with p as immediates. Split out of `fp.wac` because it is a thousand lines of
// machine-written arithmetic and `fp.wac` is meant to be read.
//
// Read `packages/bls/tools/genfpkernel.py` before changing anything here. It has the measurements
// that made this unrolled, and the two optimisations they ruled out.
//
// Everything that mentions p mentions it here. `fp.wac` keeps one array copy for the single caller
// that indexes it in a loop, and checks it against these immediates.

/** -p^-1 mod 2^32. Chosen so `m = t[0] * MINV mod 2^32` makes `t + m*p` end in a zero limb. */
const u64 MINV = 0x%08x;
"""

HELPERS = """
/** Whether `a >= p`, so the caller knows to subtract it. */
export bool atLeastP(u32[] a) {
%s
  return true;                    // exactly p
}

/** `a -= p`, in place. Only called when `a >= p`. */
export void subPInPlace(u32[] a) {
  i64 borrow = 0;
  i64 d = 0;
%s
}

/** `a += p`, in place. Used to correct a subtraction that underflowed. */
export void addPInPlace(u32[] a) {
  u64 carry = 0;
  u64 s = 0;
%s
}

/** The i-th limb of p, for the one caller that needs it as a value rather than an immediate. */
export u32 pWord(i32 i) {
%s
  return 0x%08x;
}
"""

ADD = """
/**
 * `(a + b) mod p`.
 *
 * A 381-bit prime in 384 bits leaves three spare bits, so the sum of two reduced values cannot
 * overflow the array — but it can exceed p, and at most once.
 */
export u32[] montAdd(u32[] a, u32[] b) {
  u32[] out = u32[12]();
  u64 carry = 0;
  u64 s = 0;
%s
  if (carry != 0 || atLeastP(out)) { subPInPlace(out); }
  return out;
}
"""

SUB = """
/** `(a - b) mod p`. On underflow, add p back — the same as working modulo 2^384 and correcting. */
export u32[] montSub(u32[] a, u32[] b) {
  u32[] out = u32[12]();
  i64 borrow = 0;
  i64 d = 0;
%s
  if (borrow != 0) { addPInPlace(out); }
  return out;
}
"""

MUL_DOC = """
/**
 * `a * b * R^-1 mod p`, with both operands and the result in Montgomery form.
 *
 * CIOS (Koç, Acar, Kaliski): one pass per limb of `b`, each pass multiplying `a * b[i]` into the
 * accumulator and then performing one reduction step. The reduction stores to `t[j-1]`, so the
 * division by 2^32 that Montgomery form pays for happens as a side effect of work already being
 * done — there is no separate shift pass.
 *
 * One conditional subtraction at the end is enough: CIOS leaves a result below 2p, never more.
 */
"""


def limbs(fmt):
    return "\n".join(fmt(i) for i in range(N))


def emit():
    ge = "\n".join(
        "  if (a[%d] != 0x%08x) { return (a[%d] as u64) > 0x%08x; }" % (i, P[i], i, P[i])
        for i in range(N - 1, -1, -1))
    sub_ip = limbs(lambda i:
        "  d = (a[%d] as i64) - 0x%08x - borrow;\n"
        "  a[%d] = (d & 0xFFFFFFFF) as@ u32;\n"
        "  borrow = (d < 0) ? 1 : 0;" % (i, P[i], i))
    add_ip = limbs(lambda i:
        "  s = (a[%d] as u64) + 0x%08x + carry;\n"
        "  a[%d] = (s & 0xFFFFFFFF) as@ u32;\n"
        "  carry = s >> 32;" % (i, P[i], i))
    pword = "\n".join("  if (i == %d) { return 0x%08x; }" % (i, P[i]) for i in range(N - 1))
    add_body = limbs(lambda i:
        "  s = (a[%d] as u64) + (b[%d] as u64) + carry;\n"
        "  out[%d] = (s & 0xFFFFFFFF) as@ u32;\n"
        "  carry = s >> 32;" % (i, i, i))
    sub_body = limbs(lambda i:
        "  d = (a[%d] as i64) - (b[%d] as i64) - borrow;\n"
        "  out[%d] = (d & 0xFFFFFFFF) as@ u32;\n"
        "  borrow = (d < 0) ? 1 : 0;" % (i, i, i))

    out = [HEADER % INV,
           HELPERS % (ge, sub_ip, add_ip, pword, P[N - 1]),
           ADD % add_body,
           SUB % sub_body,
           MUL_DOC,
           "export u32[] montMul(u32[] a, u32[] b) {"]

    body = []
    body += ["  u64 a%d = a[%d] as u64;" % (j, j) for j in range(N)]
    body += ["  u64 t%d = 0;" % j for j in range(N + 1)]
    body += ["  u64 %s = 0;" % v for v in ("spill", "carry", "acc", "hi", "m", "bi")]
    for i in range(N):
        body.append("")
        body.append("  // pass %d: t += a * b[%d], then one reduction step" % (i, i))
        body.append("  bi = b[%d] as u64;" % i)
        body.append("  carry = 0;")
        for j in range(N):
            body.append("  acc = t%d + a%d * bi + carry;" % (j, j))
            body.append("  t%d = acc & 0xFFFFFFFF;" % j)
            body.append("  carry = acc >> 32;")
        body.append("  hi = t%d + carry;" % N)
        body.append("  t%d = hi & 0xFFFFFFFF;" % N)
        body.append("  spill = hi >> 32;")
        body.append("  m = (t0 * MINV) & 0xFFFFFFFF;")
        body.append("  carry = (t0 + 0x%08x * m) >> 32;" % P[0])
        for j in range(1, N):
            body.append("  acc = t%d + 0x%08x * m + carry;" % (j, P[j]))
            body.append("  t%d = acc & 0xFFFFFFFF;" % (j - 1))
            body.append("  carry = acc >> 32;")
        body.append("  hi = t%d + carry;" % N)
        body.append("  t%d = hi & 0xFFFFFFFF;" % (N - 1))
        body.append("  t%d = spill + (hi >> 32);" % N)
    body.append("")
    body.append("  u32[] out = u32[12]();")
    body += ["  out[%d] = (t%d & 0xFFFFFFFF) as@ u32;" % (j, j) for j in range(N)]
    body.append("  if (t%d != 0 || atLeastP(out)) { subPInPlace(out); }" % N)
    body.append("  return out;")
    body.append("}")
    out.append("\n".join(body))
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    text = emit()
    if "--stdout" in sys.argv:
        sys.stdout.write(text)
    else:
        out = pathlib.Path(__file__).resolve().parents[1] / "src" / "fpkernel.wac"
        out.write_text(text)
        print(f"src/fpkernel.wac: {len(text.splitlines())} lines")
