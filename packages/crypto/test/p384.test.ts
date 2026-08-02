// P-384's field against BigInt, and the inputs it must refuse.
//
// The ECDSA differential, the group order and the r/s range checks moved to
// `test/wac/nistcurve_test.wac`, alongside P-256's — they are one implementation now, and
// testing them together is what checks the generalisation rather than one curve twice.
//
// What stayed: the field against BigInt, for the representative reason field25519
// documents; the refusals, which trap; the wrong-key check; and the SHA-256-under-P-384
// case, where a digest shorter than the order is right-aligned rather than padded.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/crypto/test/wac/p256_probe.wac");
const pAdd = mod.pAdd as (a: Uint8Array, b: Uint8Array) => Uint8Array;
const pSub = mod.pSub as (a: Uint8Array, b: Uint8Array) => Uint8Array;
const pMul = mod.pMul as (a: Uint8Array, b: Uint8Array) => Uint8Array;
const pSquare = mod.pSquare as (a: Uint8Array) => Uint8Array;
const pInvert = mod.pInvert as (a: Uint8Array) => Uint8Array;
const pNeg = mod.pNeg as (a: Uint8Array) => Uint8Array;
const pRoundTrip = mod.pRoundTrip as (a: Uint8Array) => Uint8Array;
const pInRange = mod.pInRange as (a: Uint8Array) => boolean;
const verify384 = mod.verify384 as (pub: Uint8Array, msg: Uint8Array, sig: Uint8Array) => boolean;
const verify384Digest =
  mod.verify384Digest as (pub: Uint8Array, d: Uint8Array, sig: Uint8Array) => boolean;
const order384 = mod.order384 as () => Uint8Array;

const P = (1n << 384n) - (1n << 128n) - (1n << 96n) + (1n << 32n) - 1n;
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFC7634D81F4372DDF581A0DB248B0A77AECEC196ACCC52973n;

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");

/** A field element or scalar as 48 big-endian bytes. */
function enc(v: bigint, m = P): Uint8Array {
  const out = new Uint8Array(48);
  let x = ((v % m) + m) % m;
  for (let i = 47; i >= 0; i--) {
    out[i] = Number(x & 0xFFn);
    x >>= 8n;
  }
  return out;
}

const dec = (b: Uint8Array) => BigInt("0x" + (hex(b) || "0"));

/**
 * Inputs chosen to sit on the boundaries the reduction cares about.
 *
 * Random values almost never produce a carry out of the top limb, and never produce the
 * repeated negative carry that P-384's -2^32 term can. p-1 squared, and values just below
 * powers of two that appear in the prime, do.
 */
function corpus(): bigint[] {
  const xs: bigint[] = [
    0n, 1n, 2n, P - 1n, P - 2n, (P - 1n) / 2n,
    (1n << 32n) - 1n, 1n << 32n, (1n << 32n) + 1n,
    (1n << 96n) - 1n, 1n << 96n, (1n << 96n) + 1n,
    (1n << 128n) - 1n, 1n << 128n, (1n << 128n) + 1n,
    (1n << 192n), (1n << 256n), (1n << 383n),
  ];
  let seed = 0x9E3779B9n;
  for (let i = 0; i < 40; i++) {
    let v = 0n;
    for (let j = 0; j < 6; j++) {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      v = (v << 64n) | seed;
    }
    xs.push(v % P);
  }
  return xs;
}

Deno.test("p384 field: add, sub, mul, square and negate agree with BigInt", () => {
  const xs = corpus();
  for (const a of xs) {
    if (hex(pRoundTrip(enc(a))) !== hex(enc(a))) throw new Error(`round trip failed at ${a}`);
    if (hex(pNeg(enc(a))) !== hex(enc(-a))) throw new Error(`negate failed at ${a}`);
    if (hex(pSquare(enc(a))) !== hex(enc(a * a))) throw new Error(`square failed at ${a}`);
    for (const b of xs) {
      if (hex(pAdd(enc(a), enc(b))) !== hex(enc(a + b))) throw new Error(`add ${a} ${b}`);
      if (hex(pSub(enc(a), enc(b))) !== hex(enc(a - b))) throw new Error(`sub ${a} ${b}`);
      if (hex(pMul(enc(a), enc(b))) !== hex(enc(a * b))) throw new Error(`mul ${a} ${b}`);
    }
  }
});

Deno.test("p384 field: inversion, and that it undoes multiplication", () => {
  for (const a of corpus()) {
    if (a === 0n) continue;
    const inv = dec(pInvert(enc(a)));
    if ((a * inv) % P !== 1n) throw new Error(`inverse of ${a} is wrong`);
  }
});

Deno.test("p384 field: values at or above p are not in range", () => {
  if (!pInRange(enc(P - 1n))) throw new Error("p-1 should be in range");
  // enc() reduces, so build the out-of-range values by hand.
  const raw = (v: bigint) => {
    const out = new Uint8Array(48);
    let x = v;
    for (let i = 47; i >= 0; i--) { out[i] = Number(x & 0xFFn); x >>= 8n; }
    return out;
  };
  for (const v of [P, P + 1n, (1n << 384n) - 1n]) {
    if (pInRange(raw(v))) throw new Error(`${v} should be out of range`);
  }
});



Deno.test("p384: a signature is rejected under the wrong key", async () => {
  // The check that distinguishes verification from a self-consistent computation: a
  // signature that verifies must do so only under the key that made it.
  const a = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-384" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const b = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-384" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const msg = new TextEncoder().encode("the same message under two keys");
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-384" }, a.privateKey, msg as BufferSource));
  const pubB = new Uint8Array(await crypto.subtle.exportKey("raw", b.publicKey));
  if (verify384(pubB, msg, sig)) throw new Error("a signature verified under the wrong key");
});

Deno.test("p384: a SHA-256 digest under a P-384 key is right-aligned", async () => {
  // Legal and it happens: ecdsa-with-SHA256 on a P-384 key. The digest is shorter than
  // the order, so SEC 1 treats it as a small number rather than padding on the right. A
  // left-aligned implementation verifies nothing and would look like a broken curve.
  const kp = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-384" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const msg = new TextEncoder().encode("a short digest under a long curve");
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, kp.privateKey, msg as BufferSource));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", msg as BufferSource));
  if (!verify384Digest(pub, digest, sig)) throw new Error("a SHA-256 signature under P-384 was rejected");
});


Deno.test("p384: a coordinate at or above p is refused, even when it reduces onto the curve", () => {
  // The same check as P-256's, and worth repeating per curve because the room above p is
  // wildly different: 2^256 - p256 is about 2^224, so one random 32-byte string in 2^32
  // is out of range, while 2^384 - p384 is only about 2^128, so it is one in 2^255. That
  // makes P-384's out-of-range band unreachable by accident and no harder to construct
  // on purpose — x = 2 is on the curve, and 2 + p fits in 48 bytes.
  const B = 0xb3312fa7e23ee7e4988e056be3f82d19181d9c6efe8141120314088f5013875ac656398d8a2ed19d2a85c8edd3ec2aefn;
  const modPow = (b: bigint, e: bigint, m: bigint) => {
    let r = 1n, x = b % m;
    while (e > 0n) { if (e & 1n) r = r * x % m; x = x * x % m; e >>= 1n; }
    return r;
  };
  let x = 0n, y = 0n;
  for (let i = 1n; i < 400n; i++) {
    const rhs = (((i * i % P) * i % P) - 3n * i + B + 3n * P) % P;
    const r = modPow(rhs, (P + 1n) / 4n, P);
    if (r * r % P === rhs) { x = i; y = r; break; }
  }
  if (x === 0n) throw new Error("no small-x point found; the search bound is too tight");
  if (x + P >= (1n << 384n)) throw new Error("x + p does not fit; pick a smaller x");

  /** 48 big-endian bytes with no reduction, so an out-of-range value survives encoding. */
  const raw = (v: bigint) => {
    const o = new Uint8Array(48);
    for (let i = 47; i >= 0; i--) { o[i] = Number(v & 0xFFn); v >>= 8n; }
    return o;
  };
  const point = (xv: bigint, yv: bigint) => {
    const out = new Uint8Array(97);
    out[0] = 4;
    out.set(raw(xv), 1);
    out.set(raw(yv), 49);
    return out;
  };
  const traps = (f: () => unknown) => { try { f(); return false; } catch { return true; } };

  // verify384 decodes the public key, so a refused encoding shows up as a trap. The
  // canonical point is decoded fine and merely fails to verify a nonsense signature,
  // which is the difference this test turns on: false, not a throw.
  const sig = new Uint8Array(96);
  sig[47] = 1;
  sig[95] = 1;
  const msg = new TextEncoder().encode("canonicity");
  if (traps(() => verify384(point(x, y), msg, sig))) {
    throw new Error("the canonical point was rejected");
  }
  if (!traps(() => verify384(point(x + P, y), msg, sig))) {
    throw new Error("accepted x + p as x");
  }
});

Deno.test("p384 field: a length that is not a curve this file knows is refused", () => {
  // fieldp.wac picks its prime from the operand's limb count, which makes the length the
  // only thing distinguishing P-256 arithmetic from P-384 arithmetic. That is what these
  // guards protect: a 16-byte "field element" has four limbs and no prime, and reducing
  // it modulo whichever table happened to be returned would be arithmetic in a ring
  // nobody chose. The guards existed and nothing reached them — every internal caller
  // passes 32 or 48 — but the probe hands raw byte arrays across, so they are reachable
  // from the boundary and worth pinning there.
  const traps = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
  const bytes = (n: number) => new Uint8Array(n);

  for (const n of [1, 33, 47, 49]) {
    if (!traps(() => pRoundTrip(bytes(n)))) throw new Error(`accepted a ${n}-byte element`);
  }
  // Multiples of four that are not eight or twelve limbs: the second guard, not the first.
  for (const n of [16, 64, 4]) {
    if (!traps(() => pRoundTrip(bytes(n)))) throw new Error(`accepted a ${n}-byte element`);
  }
  // Two operands from different curves. Nothing mixes them internally — a Curve's b, its
  // base point and every intermediate come from one decode — so this is the guard that
  // stops a future caller reducing a P-256 product modulo the P-384 prime in silence.
  if (!traps(() => pMul(bytes(32), bytes(48)))) throw new Error("multiplied across curves");
  if (!traps(() => pMul(bytes(48), bytes(32)))) throw new Error("multiplied across curves");

  // The sizes that are curves still work.
  if (pRoundTrip(bytes(32)).length !== 32) throw new Error("32 bytes stopped working");
  if (pRoundTrip(bytes(48)).length !== 48) throw new Error("48 bytes stopped working");
});
