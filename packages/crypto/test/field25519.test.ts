// The field against BigInt.
//
// Kept rather than replaced by `test/wac/field25519_test.wac`, which checks the same
// arithmetic by its own laws. Those laws, plus anchors naming the modulus, plus boundary
// values around p, all pass when the carry is one pass short of complete — because a
// non-canonical representative is congruent, so it satisfies every relation the field can
// state about itself. An outside reference sees it immediately.
//
// So the two are complements: the wac file covers breadth and the properties a reference
// cannot state cheaply, and this covers representatives.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/crypto/test/wac/curve25519_probe.wac");
const fAdd = mod.fAdd as (a: Uint8Array, b: Uint8Array) => Uint8Array;
const fSub = mod.fSub as (a: Uint8Array, b: Uint8Array) => Uint8Array;
const fMul = mod.fMul as (a: Uint8Array, b: Uint8Array) => Uint8Array;
const fSquare = mod.fSquare as (a: Uint8Array) => Uint8Array;
const fMulSmall = mod.fMulSmall as (a: Uint8Array, m: bigint) => Uint8Array;
const fInvert = mod.fInvert as (a: Uint8Array) => Uint8Array;
const fRoundTrip = mod.fRoundTrip as (a: Uint8Array) => Uint8Array;
const fCSwap = mod.fCSwap as (a: Uint8Array, b: Uint8Array, s: number) => Uint8Array;

const P = (1n << 255n) - 19n;

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");

/** A field element as 32 little-endian bytes. */
function enc(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = ((v % P) + P) % P;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(x & 0xFFn);
    x >>= 8n;
  }
  return out;
}

const dec = (b: Uint8Array) => {
  let v = 0n;
  for (let i = 31; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
  return v;
};

function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  let r = 1n, b = base % m, e = exp;
  while (e > 0n) {
    if (e & 1n) r = r * b % m;
    b = b * b % m;
    e >>= 1n;
  }
  return r;
}

/**
 * The values every case runs over.
 *
 * The named ones first: zero and one, the two limb widths and their boundaries, p-1 and
 * p-2 where the final conditional subtraction bites, and 2^254 where the top limb is at
 * its widest. Then a deterministic pseudo-random spread, from a fixed seed so a failure
 * reproduces exactly.
 */
function values(): bigint[] {
  const out: bigint[] = [
    0n, 1n, 2n, 19n, 18n, 20n,
    P - 1n, P - 2n, P - 19n, (P - 1n) / 2n,
    (1n << 25n), (1n << 25n) - 1n, (1n << 25n) + 1n,
    (1n << 26n), (1n << 26n) - 1n, (1n << 26n) + 1n,
    (1n << 51n), (1n << 128n), (1n << 254n), (1n << 254n) - 1n,
  ];
  let seed = 0x2545F491n;
  const next = () => {
    let v = 0n;
    for (let i = 0; i < 4; i++) {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      v = (v << 64n) | seed;
    }
    return v % P;
  };
  for (let i = 0; i < 250; i++) out.push(next());
  return out;
}

const VALUES = values();

/** Compare against BigInt, reporting the input that failed rather than only that one did. */
function agrees(label: string, got: Uint8Array, want: bigint): void {
  if (hex(got) !== hex(enc(want))) {
    throw new Error(`${label}\n  got  ${hex(got)}\n  want ${hex(enc(want))}`);
  }
}

Deno.test("field25519: encoding round-trips, and reduces non-canonically encoded input", () => {
  for (const a of VALUES) agrees(`roundTrip(${a})`, fRoundTrip(enc(a)), a);

  // Bit 255 must be ignored, per RFC 7748 §5: "implementations MUST mask the most
  // significant bit". A peer that sets it is not encoding a larger number.
  for (const a of [0n, 1n, P - 1n, 12345n]) {
    const withTopBit = enc(a);
    withTopBit[31] |= 0x80;
    agrees(`bit 255 ignored for ${a}`, fRoundTrip(withTopBit), a);
  }

  // Values in [p, 2^255) are not canonical encodings but do arrive from the wire; they
  // must reduce rather than be taken at face value.
  for (const a of [P, P + 1n, P + 18n, (1n << 255n) - 1n]) {
    agrees(`non-canonical ${a}`, fRoundTrip(enc(a % P)), a % P);
  }
});

Deno.test("field25519: add, sub, mul and square agree with BigInt", () => {
  for (let i = 0; i < VALUES.length; i++) {
    const a = VALUES[i];
    const b = VALUES[(i * 7 + 3) % VALUES.length];
    agrees(`${a} + ${b}`, fAdd(enc(a), enc(b)), (a + b) % P);
    agrees(`${a} - ${b}`, fSub(enc(a), enc(b)), ((a - b) % P + P) % P);
    agrees(`${a} * ${b}`, fMul(enc(a), enc(b)), a * b % P);
    agrees(`${a}^2`, fSquare(enc(a)), a * a % P);
  }
});

Deno.test("field25519: the small multiply agrees at every multiplier the curve uses", () => {
  // 121665 is a24, the constant in the ladder's differential-add step. 121666 is beside
  // it because that is the constant a *different* arrangement of the same step uses, and
  // confusing the two is the classic Curve25519 transcription error — it produces a
  // ladder that is wrong for every input, which at least fails loudly.
  for (const a of VALUES) {
    for (const m of [0n, 1n, 2n, 121665n, 121666n, 0xFFFFn, 0xFFFFFFn]) {
      agrees(`${a} * ${m}`, fMulSmall(enc(a), m), a * m % P);
    }
  }
});

Deno.test("field25519: inversion, including that zero maps to zero", () => {
  for (const a of VALUES) {
    // Fermat: a^(p-2) is the inverse for a != 0, and 0 for a = 0, which is what the
    // exponentiation naturally yields and what the ladder relies on for the identity.
    agrees(`1/${a}`, fInvert(enc(a)), a === 0n ? 0n : modPow(a, P - 2n, P));
  }
  // The defining property, checked directly rather than through the exponent: a * (1/a)
  // is 1. This would catch an inversion that matched a wrong reference.
  for (const a of VALUES.slice(0, 40)) {
    if (a === 0n) continue;
    agrees(`${a} * 1/${a}`, fMul(enc(a), fInvert(enc(a))), 1n);
  }
});

Deno.test("field25519: conditional swap swaps on 1 and does nothing on 0", () => {
  for (let i = 0; i < 20; i++) {
    const a = VALUES[i], b = VALUES[VALUES.length - 1 - i];
    const kept = fCSwap(enc(a), enc(b), 0);
    if (dec(kept.subarray(0, 32)) !== a || dec(kept.subarray(32)) !== b) {
      throw new Error(`cswap(0) moved something: ${a}, ${b}`);
    }
    const swapped = fCSwap(enc(a), enc(b), 1);
    if (dec(swapped.subarray(0, 32)) !== b || dec(swapped.subarray(32)) !== a) {
      throw new Error(`cswap(1) did not swap: ${a}, ${b}`);
    }
  }
});
