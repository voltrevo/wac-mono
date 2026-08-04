// The Miller loop, against a Python implementation that `@noble/curves` validated.
//
// The chain of oracles matters here more than anywhere else in this package, because a pairing
// that is simply *wrong* still satisfies bilinearity, non-degeneracy and order-r — my first
// attempt did all three. So:
//
//   `@noble/curves`  ──validates──▶  `test/pairing.py`  ──generates──▶  these vectors
//
// noble is an independent implementation; the Python reproduces its algorithm in plain integers
// and was checked against it coefficient by coefficient; the vectors come from the Python. Nothing
// in that chain is this implementation checking itself.
//
// The *final exponentiation* is deliberately not compared against noble: this package raises to a
// fixed multiple of (p¹²−1)/r, as the standard chain does, so the pairing's value differs from
// noble's by a constant. Verification compares a product against one, where a constant power
// cancels — and that property is what `verify_wac.test.ts` checks against the Ethereum fixtures.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/bls/test/wac/probe.wac") as unknown as {
  blsMillerLoop(g1c: Uint8Array, g2c: Uint8Array): Uint8Array;
  blsPairing(g1c: Uint8Array, g2c: Uint8Array): Uint8Array;
  blsPairingInverse(g1c: Uint8Array, g2c: Uint8Array): boolean;
  blsFp12Op(a: Uint8Array, b: Uint8Array, op: number): Uint8Array;
  blsMillerLoopTwo(a1: Uint8Array, b1: Uint8Array, a2: Uint8Array, b2: Uint8Array): Uint8Array;
};

type Cases = { cases: { a: string; b: string; p: string; q: string; miller: string[] }[] };
const v: Cases = JSON.parse(await Deno.readTextFile(new URL("pairing.json", import.meta.url)));
const bytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const coeffs = (b: Uint8Array) => {
  const out: string[] = [];
  for (let i = 0; i < b.length; i += 48) out.push(hex(b.subarray(i, i + 48)));
  return out;
};

Deno.test("the Miller loop matches, coefficient by coefficient", () => {
  for (const c of v.cases) {
    const got = mod.blsMillerLoop(bytes(c.p), bytes(c.q));
    if (got.length === 0) throw new Error(`(${c.a},${c.b}): a point was refused`);
    const g = coeffs(got);
    for (let i = 0; i < 12; i++) {
      if (g[i] !== c.miller[i]) {
        throw new Error(`(${c.a},${c.b}) coefficient ${i}\n  got  ${g[i]}\n  want ${c.miller[i]}`);
      }
    }
  }
});

Deno.test("e(P,Q)·e(−P,Q) == 1, so the final exponentiation is at least a homomorphism", () => {
  // Weak on its own — it holds for a wrong pairing too — but it is the one property of the final
  // exponentiation that needs no external value, and it fails loudly if the chain is broken
  // enough to leave the subgroup.
  for (const c of v.cases) {
    if (!mod.blsPairingInverse(bytes(c.p), bytes(c.q))) {
      throw new Error(`(${c.a},${c.b}): e(P,Q)·e(−P,Q) != 1`);
    }
  }
});

Deno.test("the pairing refuses the identity rather than returning one", () => {
  const infG1 = new Uint8Array(48); infG1[0] = 0xc0;
  const infG2 = new Uint8Array(96); infG2[0] = 0xc0;
  if (mod.blsPairing(infG1, bytes(v.cases[0].q)).length !== 0) {
    throw new Error("e(O, Q) returned a value");
  }
  if (mod.blsPairing(bytes(v.cases[0].p), infG2).length !== 0) {
    throw new Error("e(P, O) returned a value");
  }
});

// Granger–Scott cyclotomic squaring is only valid inside GΦ₆(p²), so the test has to establish
// both halves: that it agrees with general squaring on a genuine cyclotomic element, and that it
// does *not* agree off the subgroup. Without the second half the first proves nothing — a stubbed
// `fp12CyclotomicSquare` that simply called `fp12Square` would pass it.
//
// The cyclotomic element is built from ops this file's vectors already validate: the easy part of
// the final exponentiation is x^((p⁶−1)(p²+1)), and on Fp12 the p⁶ map is conjugation.
Deno.test("cyclotomic squaring agrees with general squaring on the subgroup, and not off it", () => {
  const mul = (a: Uint8Array, b: Uint8Array) => mod.blsFp12Op(a, b, 0);
  const one = (a: Uint8Array, op: number) => mod.blsFp12Op(a, a, op);
  const easyPart = (x: Uint8Array) => {
    const t = mul(one(x, 2), one(x, 3)); // x^p⁶ · x⁻¹
    return mul(one(t, 5), t); //             ^(p²+1)
  };

  let agreed = 0, differed = 0;
  for (const c of v.cases) {
    const raw = mod.blsMillerLoop(bytes(c.p), bytes(c.q));
    if (raw.length === 0) throw new Error(`(${c.a},${c.b}): a point was refused`);

    const cyc = easyPart(raw);
    if (hex(one(cyc, 7)) !== hex(one(cyc, 1))) {
      throw new Error(`(${c.a},${c.b}) cyclotomic square disagrees on the subgroup\n` +
        `  cyclotomic ${coeffs(one(cyc, 7))[0]}\n  general    ${coeffs(one(cyc, 1))[0]}`);
    }
    agreed++;

    // The raw Miller loop output is not cyclotomic — the easy part is what puts it there.
    if (hex(one(raw, 7)) !== hex(one(raw, 1))) differed++;
  }
  if (agreed === 0) throw new Error("no cases ran");
  if (differed !== agreed) {
    throw new Error(`cyclotomic squaring matched general squaring off the subgroup in ` +
      `${agreed - differed}/${agreed} cases — it cannot be subgroup-specific, so this test is vacuous`);
  }
});

// The shared two-pair Miller loop must equal the product of two separate ones. It is a plain
// algebraic identity, but the loop it comes from interleaves squarings and line multiplications
// across both pairs, so an off-by-one in that interleaving would give a value that is still
// bilinear — the exact failure mode this file's header warns about. Checked against the product of
// the already-vector-verified single loops rather than against the fixtures, which would only say
// that verification still happens to work.
Deno.test("the two-pair Miller loop equals the product of two single loops", () => {
  let ran = 0;
  for (let i = 0; i + 1 < v.cases.length; i++) {
    const c = v.cases[i], d = v.cases[i + 1];
    const shared = mod.blsMillerLoopTwo(bytes(c.p), bytes(c.q), bytes(d.p), bytes(d.q));
    if (shared.length === 0) throw new Error(`case ${i}: a point was refused`);
    const product = mod.blsFp12Op(mod.blsMillerLoop(bytes(c.p), bytes(c.q)),
                                 mod.blsMillerLoop(bytes(d.p), bytes(d.q)), 0);
    if (hex(shared) !== hex(product)) {
      const s = coeffs(shared), p = coeffs(product);
      const bad = s.findIndex((x, j) => x !== p[j]);
      throw new Error(`case ${i}: shared loop != product, first differing coefficient ${bad}\n` +
        `  shared  ${s[bad]}\n  product ${p[bad]}`);
    }
    ran++;
  }
  if (ran === 0) throw new Error("no pairs to compare");
});
