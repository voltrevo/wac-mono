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
