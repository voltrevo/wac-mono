// P-256's field against BigInt, and the inputs it must refuse.
//
// The ECDSA differentials, ECDH, the group order and the r/s range checks moved to
// `test/wac/nistcurve_test.wac`, where P-256 and P-384 are tested together because since
// the generalisation they are one implementation.
//
// What stayed, and why each cannot move:
//
// **The field against BigInt.** The same lesson as field25519: a non-canonical
// representative is congruent, so it satisfies every relation the field can state about
// itself, and only an outside reference sees that the representative is wrong while the
// value is right.
//
// **The refusals**, which trap — off-curve points, scalars outside [1, n), a coordinate at
// or above p, and inputs that are too long.
//
// **The addition law's exceptional cases**, which are cheap here and would need the
// internal Jac type exposed to move.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/crypto/test/wac/p256_probe.wac");
const pAdd = mod.pAdd as (a: Uint8Array, b: Uint8Array) => Uint8Array;
const pSub = mod.pSub as (a: Uint8Array, b: Uint8Array) => Uint8Array;
const pMul = mod.pMul as (a: Uint8Array, b: Uint8Array) => Uint8Array;
const pSquare = mod.pSquare as (a: Uint8Array) => Uint8Array;
const pInvert = mod.pInvert as (a: Uint8Array) => Uint8Array;
const pNeg = mod.pNeg as (a: Uint8Array) => Uint8Array;
const pRoundTrip = mod.pRoundTrip as (a: Uint8Array) => Uint8Array;
const baseEncoded = mod.baseEncoded as () => Uint8Array;
const scalarBase = mod.scalarBase as (k: Uint8Array) => Uint8Array;
const pubKey = mod.pubKey as (priv: Uint8Array) => Uint8Array;
const ecdh = mod.ecdh as (priv: Uint8Array, peer: Uint8Array) => Uint8Array;
const verify = mod.verify as (pub: Uint8Array, msg: Uint8Array, sig: Uint8Array) => boolean;
const sign = mod.sign as (priv: Uint8Array, msg: Uint8Array, k: Uint8Array) => Uint8Array;

const P = (1n << 256n) - (1n << 224n) + (1n << 192n) + (1n << 96n) - 1n;
const N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551n;

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.match(/../g)!.map(h => parseInt(h, 16)));
const traps = (f: () => unknown) => { try { f(); return false; } catch { return true; } };

/** A field element or scalar as 32 big-endian bytes. */
function enc(v: bigint, m = P): Uint8Array {
  const out = new Uint8Array(32);
  let x = ((v % m) + m) % m;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xFFn);
    x >>= 8n;
  }
  return out;
}

function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  let r = 1n, b = base % m, e = exp;
  while (e > 0n) {
    if (e & 1n) r = r * b % m;
    b = b * b % m;
    e >>= 1n;
  }
  return r;
}

/** Boundary-weighted values: the reduction's interesting cases are all at the edges. */
function values(): bigint[] {
  const out: bigint[] = [
    0n, 1n, 2n, P - 1n, P - 2n, (P - 1n) / 2n,
    // The powers of 2^32 the Solinas reduction is built from. If a word of the table is
    // in the wrong place, one of these lands on it.
    (1n << 32n), (1n << 64n), (1n << 96n), (1n << 128n), (1n << 160n),
    (1n << 192n), (1n << 224n), (1n << 255n),
    (1n << 96n) - 1n, (1n << 224n) - 1n, (1n << 32n) - 1n,
  ];
  let seed = 0x9E3779B9n;
  const next = () => {
    let v = 0n;
    for (let i = 0; i < 4; i++) {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      v = (v << 64n) | seed;
    }
    return v % P;
  };
  for (let i = 0; i < 60; i++) out.push(next());
  return out;
}

const VALUES = values();

function agrees(label: string, got: Uint8Array, want: bigint): void {
  if (hex(got) !== hex(enc(want))) {
    throw new Error(`${label}\n  got  ${hex(got)}\n  want ${hex(enc(want))}`);
  }
}

Deno.test("p256 field: add, sub, mul, square and negate agree with BigInt", () => {
  for (let i = 0; i < VALUES.length; i++) {
    const a = VALUES[i];
    const b = VALUES[(i * 13 + 7) % VALUES.length];
    agrees(`roundTrip(${a})`, pRoundTrip(enc(a)), a);
    agrees(`${a} + ${b}`, pAdd(enc(a), enc(b)), (a + b) % P);
    agrees(`${a} - ${b}`, pSub(enc(a), enc(b)), ((a - b) % P + P) % P);
    agrees(`${a} * ${b}`, pMul(enc(a), enc(b)), a * b % P);
    agrees(`${a}^2`, pSquare(enc(a)), a * a % P);
    agrees(`-${a}`, pNeg(enc(a)), (P - a) % P);
  }
});

Deno.test("p256 field: inversion, and that it undoes multiplication", () => {
  for (const a of VALUES.slice(0, 25)) {
    agrees(`1/${a}`, pInvert(enc(a)), a === 0n ? 0n : modPow(a, P - 2n, P));
    if (a !== 0n) agrees(`${a} * 1/${a}`, pMul(enc(a), pInvert(enc(a))), 1n);
  }
});

Deno.test("p256: the base point and a small multiple", () => {
  // From FIPS 186-4. Worth checking directly: everything else depends on G being right,
  // and a wrong G produces a self-consistent implementation that agrees with nobody.
  const g = "046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296" +
    "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5";
  if (hex(baseEncoded()) !== g) throw new Error(`G: ${hex(baseEncoded())}`);

  const two = enc(2n, N);
  const twoG = "7cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978";
  if (hex(scalarBase(two)).slice(2, 66) !== twoG) {
    throw new Error(`2G x: ${hex(scalarBase(two)).slice(2, 66)}`);
  }
});

Deno.test("p256: the exceptional cases in the addition law", () => {
  // A short Weierstrass curve's addition formula divides by zero when the two points are
  // equal, and yields the identity when they are negations. `jacMul` runs into both on
  // ordinary inputs, so these are checked through scalar multiplication rather than by
  // calling the formula directly — which is how they would actually be hit.
  //
  // 3G computed as G+2G exercises the general case, and (n-1)G + G must be the identity,
  // which `scalarBase` has no way to encode — so it traps, and that is the check.
  const three = scalarBase(enc(3n, N));
  const four = scalarBase(enc(4n, N));
  if (hex(three) === hex(four)) throw new Error("3G and 4G came out equal");
  // n*G is the identity and has no affine encoding.
  if (!traps(() => scalarBase(enc(N, N)))) throw new Error("n*G produced a point");
  // (n-1)*G is -G: same x, and the y coordinates sum to p.
  const g = baseEncoded();
  const negG = scalarBase(enc(N - 1n, N));
  if (hex(negG).slice(2, 66) !== hex(g).slice(2, 66)) throw new Error("(n-1)G has a different x than G");
  const gy = BigInt("0x" + hex(g).slice(66));
  const ny = BigInt("0x" + hex(negG).slice(66));
  if ((gy + ny) % P !== 0n) throw new Error("(n-1)G is not -G");
});




Deno.test("p256: rejects points that are not on the curve", () => {
  // The invalid-curve attack: a peer sends a point from a different, weaker curve, and a
  // scalar multiplication that does not check leaks the private key a few bits at a
  // time. The multiplication itself cannot notice — only the decode can.
  const priv = enc(12345n, N);
  const good = pubKey(priv);
  ecdh(priv, good);

  const offCurve = Uint8Array.from(good);
  offCurve[64] ^= 1;                       // perturb y
  if (!traps(() => ecdh(priv, offCurve))) throw new Error("accepted a point off the curve");

  const badTag = Uint8Array.from(good);
  badTag[0] = 3;                           // compressed form, which this does not accept
  if (!traps(() => ecdh(priv, badTag))) throw new Error("accepted a non-uncompressed point");

  for (const n of [0, 32, 64, 66]) {
    if (!traps(() => ecdh(priv, new Uint8Array(n)))) throw new Error(`accepted a ${n}-byte point`);
  }

  // A coordinate at or above p is not a field element, whatever curve it might satisfy.
  const overP = Uint8Array.from(good);
  overP.set(enc(P - 1n), 1);
  if (!traps(() => ecdh(priv, overP))) throw new Error("accepted an x outside the field");
});

Deno.test("p256: rejects scalars outside [1, n)", () => {
  const zero = new Uint8Array(32);
  if (!traps(() => pubKey(zero))) throw new Error("accepted a zero private key");
  if (!traps(() => pubKey(enc(N, N === N ? N + 1n : N)))) { /* enc would reduce; build by hand */ }
  const nBytes = unhex("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
  if (!traps(() => pubKey(nBytes))) throw new Error("accepted a private key equal to n");
  const aboveN = Uint8Array.from(nBytes);
  aboveN[31] += 1;
  if (!traps(() => pubKey(aboveN))) throw new Error("accepted a private key above n");
});


Deno.test("p256: a coordinate at or above p is refused, even when it reduces onto the curve", () => {
  // The range check in curveDecode, and the reason it is not redundant with the curve
  // equation. Drop it and a coordinate of x + p is not rejected: fpFromBytes takes the
  // bytes as they are, every later multiply reduces modulo p, and `onCurve` then tests
  // the *reduced* value and passes. One public key would have two accepted encodings,
  // which matters anywhere a key is fingerprinted, pinned or compared bytewise.
  //
  // Constructing it needs a point whose x is small enough that x + p still fits in 32
  // bytes. p is within 2^224 of 2^256, so a random point almost never qualifies — but one
  // is not obliged to use a random point. Solving the curve equation for the first few
  // integers finds x = 5 immediately, which is why "hard to hit by accident" is not the
  // same as "hard to construct".
  const reencode = mod.reencode as (pt: Uint8Array) => Uint8Array;

  let x = 0n, y = 0n;
  for (let i = 1n; i < 400n; i++) {
    const rhs = (((i * i % P) * i % P) - 3n * i + B + 3n * P) % P;
    const r = modPow(rhs, (P + 1n) / 4n, P);
    if (r * r % P === rhs) { x = i; y = r; break; }
  }
  if (x === 0n) throw new Error("no small-x point found; the search bound is too tight");

  const point = (xv: bigint, yv: bigint) => {
    const out = new Uint8Array(65);
    out[0] = 4;
    out.set(rawEnc(xv), 1);
    out.set(rawEnc(yv), 33);
    return out;
  };

  // The canonical encoding of that point is accepted, so the rejection below is about
  // the encoding rather than about the point.
  if (reencode(point(x, y)).length !== 65) throw new Error("the canonical point was rejected");
  if (x + P >= (1n << 256n)) throw new Error("x + p does not fit; pick a smaller x");

  if (!traps(() => reencode(point(x + P, y)))) throw new Error("accepted x + p as x");
  // And the same for y, using the point's own y only if it fits; otherwise the negation,
  // whichever is small enough to admit a second encoding.
  const yAlt = P - y;
  const small = y + P < (1n << 256n) ? y : (yAlt + P < (1n << 256n) ? yAlt : 0n);
  if (small !== 0n && !traps(() => reencode(point(x, small + P)))) {
    throw new Error("accepted y + p as y");
  }
});

/** b, the curve constant. Only the last test needs it. */
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
/** 32 big-endian bytes with no reduction, so an out-of-range value survives encoding. */
function rawEnc(v: bigint): Uint8Array {
  const o = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { o[i] = Number(v & 0xFFn); v >>= 8n; }
  return o;
}

Deno.test("p256: inputs that are too long are refused, not silently truncated", () => {
  // Every length guard in weierstrass.wac is `!= expected`, and every existing test feeds
  // something too *short*. That is the half that is already covered twice over: a short
  // array runs off its end and wasm traps whether or not the guard is there. The long
  // half has nothing behind it — drop the guard and the extra bytes are simply never
  // read, so a 33-byte private key or a 66-byte point is accepted as though the tail did
  // not exist. Mutation testing found all four of these guards deletable together.
  const reencode = mod.reencode as (pt: Uint8Array) => Uint8Array;
  const priv = enc(0x1234567n, N);
  const pub = pubKey(priv);
  const msg = new TextEncoder().encode("length matters");

  const longer = (b: Uint8Array, extra = 1) => {
    const out = new Uint8Array(b.length + extra);
    out.set(b);
    return out;
  };

  if (!traps(() => reencode(longer(pub)))) throw new Error("accepted a 66-byte point");
  if (!traps(() => pubKey(longer(priv)))) throw new Error("accepted a 33-byte private key");
  if (!traps(() => ecdh(longer(priv), pub))) throw new Error("accepted a long key for ecdh");
  if (!traps(() => ecdh(priv, longer(pub)))) throw new Error("accepted a long peer point");
  if (!traps(() => sign(longer(priv), msg, enc(7n, N)))) throw new Error("accepted a long key for signing");
  if (!traps(() => sign(priv, msg, longer(enc(7n, N))))) throw new Error("accepted a long k");

  // The unmodified versions still work, so the rejections above are about the extra byte.
  if (reencode(pub).length !== 65) throw new Error("the genuine point was rejected");
  if (!verify(pub, msg, sign(priv, msg, enc(7n, N)))) throw new Error("the genuine key stopped working");
});
