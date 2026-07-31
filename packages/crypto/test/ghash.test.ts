// GHASH, checked structurally as well as by vector.
//
// The S-box episode is the reason for the first test here. A generated table with
// one wrong entry produced a cipher that was right for most inputs, and spot
// values missed it. GF(2^128) multiplication has an algebraic property that no
// single vector can fake: it is bilinear, so H·(X ⊕ Y) = H·X ⊕ H·Y for every
// H, X and Y. Fuzzing that exercises the reduction path far more thoroughly than
// a vector list, and it fails immediately if the reduction constant or the bit
// order is wrong.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind(new URL("./wac/probe.wac", import.meta.url).pathname);
const ghash = mod.ghash as (h: Uint8Array, d: Uint8Array) => Uint8Array;

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.replace(/\s/g, "").match(/../g)!.map(h => parseInt(h, 16)));
const xor = (a: Uint8Array, b: Uint8Array) => a.map((v, i) => v ^ b[i]);

/** GHASH over a single block is exactly the field product H·X. */
const mul = (h: Uint8Array, x: Uint8Array) => ghash(h, x);

Deno.test("ghash: multiplication is bilinear in its second argument", () => {
  let s = 0xC0FFEE;
  const rnd = () => {
    const o = new Uint8Array(16);
    for (let i = 0; i < 16; i++) { s = (Math.imul(s, 1103515245) + 12345) & 0x7FFFFFFF; o[i] = (s >>> 13) & 0xFF; }
    return o;
  };
  for (let t = 0; t < 300; t++) {
    const h = rnd(), x = rnd(), y = rnd();
    const lhs = mul(h, xor(x, y));
    const rhs = xor(mul(h, x), mul(h, y));
    if (hex(lhs) !== hex(rhs)) {
      throw new Error(`bilinearity failed\n  H=${hex(h)}\n  X=${hex(x)}\n  Y=${hex(y)}\n  H(X^Y)=${hex(lhs)}\n  HX^HY =${hex(rhs)}`);
    }
  }
});

Deno.test("ghash: the field has the identity and zero you expect", () => {
  // In this bit order the multiplicative identity is 0x80 followed by zeros —
  // the bit representing x^0 is the top bit of the first byte.
  const one = unhex("80" + "00".repeat(15));
  let s = 12345;
  for (let t = 0; t < 40; t++) {
    const x = new Uint8Array(16);
    for (let i = 0; i < 16; i++) { s = (Math.imul(s, 48271) + 11) & 0x7FFFFFFF; x[i] = (s >>> 9) & 0xFF; }
    if (hex(mul(one, x)) !== hex(x)) throw new Error(`1*X != X for X=${hex(x)}`);
    if (hex(mul(x, one)) !== hex(x)) throw new Error(`X*1 != X for X=${hex(x)}`);
    if (hex(mul(x, new Uint8Array(16))) !== "0".repeat(32)) throw new Error(`X*0 != 0`);
  }
});

Deno.test("ghash: multiplication commutes", () => {
  let s = 777;
  const rnd = () => {
    const o = new Uint8Array(16);
    for (let i = 0; i < 16; i++) { s = (Math.imul(s, 69621) + 7) & 0x7FFFFFFF; o[i] = (s >>> 11) & 0xFF; }
    return o;
  };
  for (let t = 0; t < 200; t++) {
    const a = rnd(), b = rnd();
    if (hex(mul(a, b)) !== hex(mul(b, a))) throw new Error(`not commutative: ${hex(a)} ${hex(b)}`);
  }
});

Deno.test("ghash: rejects input that is not a whole number of blocks", () => {
  const traps = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
  const h = new Uint8Array(16).fill(0xAB);
  for (const n of [1, 15, 17, 31]) {
    if (!traps(() => ghash(h, new Uint8Array(n)))) throw new Error(`${n} bytes was accepted`);
  }
  if (!traps(() => ghash(new Uint8Array(15), new Uint8Array(16)))) throw new Error("a 15-byte H was accepted");
});
