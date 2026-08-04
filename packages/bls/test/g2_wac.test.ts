// G2: points on the twist, the 96-byte encoding, and its refusals.
//
// This is the file that reads attacker-supplied bytes — a signature *is* a G2 point — so the
// refusals carry more weight here than anywhere else in the package. Oracle is `test/g2.py`,
// affine Fp2 arithmetic in plain Python, which also asserts that the generator is on the twist
// and has order r before emitting anything.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/bls/test/wac/probe.wac") as unknown as {
  blsG2Status(s: Uint8Array): number;
  blsG2X(s: Uint8Array): Uint8Array;
  blsG2Y(s: Uint8Array): Uint8Array;
  blsG2RoundTrip(s: Uint8Array): Uint8Array;
  blsG2MulGenerator(k: Uint32Array): Uint8Array;
  blsG2GeneratorBytes(): Uint8Array;
  blsG2DegenerateAddition(): boolean;
  blsG2OrderIsR(): boolean;
};

type G2Vectors = {
  good: { hex: string; x: string[] | null; y: string[] | null }[];
  bad: { why: string; hex: string }[];
};
const v: G2Vectors = JSON.parse(await Deno.readTextFile(new URL("g2.json", import.meta.url)));
const bytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

Deno.test("valid G2 points decompress to the coordinates Python computed", () => {
  for (const g of v.good) {
    const s = bytes(g.hex);
    const status = mod.blsG2Status(s);
    if (status !== 0) throw new Error(`${g.hex.slice(0, 16)}… refused with status ${status}`);
    if (g.x === null) continue;
    if (hex(mod.blsG2X(s)) !== g.x.join("")) {
      throw new Error(`x\n  got  ${hex(mod.blsG2X(s))}\n  want ${g.x.join("")}`);
    }
    if (hex(mod.blsG2Y(s)) !== g.y!.join("")) {
      throw new Error(`y\n  got  ${hex(mod.blsG2Y(s))}\n  want ${g.y!.join("")}`);
    }
  }
});

Deno.test("G2 compression round-trips", () => {
  // The sign convention on Fp2 compares c1 before c0, which is easy to get backwards and shows
  // up only as a y that is the negation of the right one — invisible without a round trip.
  for (const g of v.good) {
    const back = hex(mod.blsG2RoundTrip(bytes(g.hex)));
    if (back !== g.hex) throw new Error(`round trip\n  in   ${g.hex}\n  out  ${back}`);
  }
});

Deno.test("every malformed G2 encoding is refused as malformed", () => {
  for (const b of v.bad) {
    const status = mod.blsG2Status(bytes(b.hex));
    if (status === 0) throw new Error(`accepted: ${b.why}`);
    if (status !== 1) throw new Error(`${b.why}: expected encoding refusal, got status ${status}`);
  }
  for (const n of [0, 48, 95, 97, 192]) {
    if (mod.blsG2Status(new Uint8Array(n)) === 0) throw new Error(`a ${n}-byte input was accepted`);
  }
});

Deno.test("the G2 generator has order r, and the degenerate additions are right", () => {
  if (!mod.blsG2DegenerateAddition()) throw new Error("P + (−P) or P + P is wrong on G2");
  if (!mod.blsG2OrderIsR()) throw new Error("r·G2 is not the point at infinity");
});

Deno.test("G2 scalar multiples match Python", () => {
  const scalar = (k: bigint) => {
    const out = new Uint32Array(8);
    for (let i = 0; i < 8; i++) out[i] = Number((k >> BigInt(32 * i)) & 0xffffffffn);
    return out;
  };
  if (hex(mod.blsG2GeneratorBytes()) !== v.good[1].hex) throw new Error("generator wrong");
  if (hex(mod.blsG2MulGenerator(scalar(2n))) !== v.good[2].hex) throw new Error("2·G wrong");
  if (hex(mod.blsG2MulGenerator(scalar(3n))) !== v.good[3].hex) throw new Error("3·G wrong");
});
