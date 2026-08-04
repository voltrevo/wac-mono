// G1: points, the compressed encoding, and every refusal a verifier owes its caller.
//
// The oracle is `test/g1.py` — affine arithmetic in plain Python integers with `pow(x, -1, p)`
// for inversion, against an implementation in Jacobian coordinates with Montgomery-form limbs.
// The two share no representation, so a coordinate-system or carry bug cannot be present in
// both.
//
// The refusals matter more than the acceptances and there are more of them here for that
// reason. Each one is a byte string that a careless reader turns into a valid point, and each
// is a signature that would verify when it must not.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/bls/test/wac/probe.wac") as unknown as {
  blsG1Status(s: Uint8Array): number;
  blsG1X(s: Uint8Array): Uint8Array;
  blsG1Y(s: Uint8Array): Uint8Array;
  blsG1RoundTrip(s: Uint8Array): Uint8Array;
  blsG1MulGenerator(k: Uint32Array): Uint8Array;
  blsG1GeneratorBytes(): Uint8Array;
  blsG1DegenerateAddition(): boolean;
  blsG1OrderIsR(): boolean;
  blsOrderIsNotSmaller(): boolean;
};

type G1Vectors = {
  good: { hex: string; x: string | null; y: string | null }[];
  bad: { why: string; hex: string }[];
};
const v: G1Vectors = JSON.parse(await Deno.readTextFile(new URL("g1.json", import.meta.url)));
const bytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

Deno.test("valid points decompress to the coordinates Python computed", () => {
  for (const g of v.good) {
    const s = bytes(g.hex);
    const status = mod.blsG1Status(s);
    if (status !== 0) throw new Error(`${g.hex.slice(0, 16)}… refused with status ${status}`);
    if (g.x === null) continue;                    // infinity has no affine coordinates
    if (hex(mod.blsG1X(s)) !== g.x) {
      throw new Error(`x\n  got  ${hex(mod.blsG1X(s))}\n  want ${g.x}`);
    }
    if (hex(mod.blsG1Y(s)) !== g.y) {
      throw new Error(`y\n  got  ${hex(mod.blsG1Y(s))}\n  want ${g.y}`);
    }
  }
});

Deno.test("compression round-trips, so there is one encoding per point", () => {
  // The sign bit is recovered from y, so a point whose y is the smaller root and one whose y is
  // the larger must come back as different bytes — and as the same bytes they went in as.
  for (const g of v.good) {
    const back = hex(mod.blsG1RoundTrip(bytes(g.hex)));
    if (back !== g.hex) throw new Error(`round trip\n  in   ${g.hex}\n  out  ${back}`);
  }
});

Deno.test("every malformed encoding is refused, and refused as malformed", () => {
  for (const b of v.bad) {
    const status = mod.blsG1Status(bytes(b.hex));
    if (status === 0) throw new Error(`accepted: ${b.why}`);
    // Status 1 means the *encoding* was rejected, which is the correct answer for all of these
    // — a point that decodes and then fails the curve check would be status 2, and that would
    // mean the encoding reader let something through it should have caught.
    if (status !== 1) throw new Error(`${b.why}: expected encoding refusal, got status ${status}`);
  }
  // Wrong lengths too, since the caller controls those.
  for (const n of [0, 47, 49, 96]) {
    if (mod.blsG1Status(new Uint8Array(n)) === 0) throw new Error(`a ${n}-byte input was accepted`);
  }
});

Deno.test("the generator has order r, and the degenerate additions are right", () => {
  // `P + (−P)` and `P + P` are the two cases the addition formula cannot handle directly: the
  // first is infinity, the second needs the tangent. A formula that ignores them returns zeroes.
  if (!mod.blsG1DegenerateAddition()) throw new Error("P + (−P) or P + P is wrong");
  if (!mod.blsG1OrderIsR()) throw new Error("r·G is not the point at infinity");
});

Deno.test("scalar multiples of the generator match Python", () => {
  const scalar = (k: bigint) => {
    const out = new Uint32Array(8);
    for (let i = 0; i < 8; i++) out[i] = Number((k >> BigInt(32 * i)) & 0xffffffffn);
    return out;
  };
  // The vectors were built as 1·G, 2·G, 3·G and (r−1)·G among others; check the small ones
  // directly against their own encodings.
  const gen = hex(mod.blsG1GeneratorBytes());
  if (gen !== v.good[1].hex) throw new Error(`generator\n  got  ${gen}\n  want ${v.good[1].hex}`);
  if (hex(mod.blsG1MulGenerator(scalar(2n))) !== v.good[2].hex) throw new Error("2·G wrong");
  if (hex(mod.blsG1MulGenerator(scalar(3n))) !== v.good[3].hex) throw new Error("3·G wrong");
});

// `r·G == O` on its own is satisfied by an empty scalar — multiplying by nothing leaves infinity —
// so it passed while `groupOrder` returned nothing at all. Found by a mutation sweep. The order is
// only pinned by checking both directions.
Deno.test("the group order is r exactly, not merely a multiple of it", () => {
  if (!mod.blsG1OrderIsR()) throw new Error("r·G1 is not the point at infinity");
  if (!mod.blsOrderIsNotSmaller()) {
    throw new Error("(r−1)·G is infinity, so the scalar being used is not r");
  }
});
