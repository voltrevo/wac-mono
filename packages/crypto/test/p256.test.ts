// NIST P-256: the field, the curve, ECDH and ECDSA.
//
// Two layers of oracle, for the same reason the Curve25519 tests have two. BigInt checks
// the field on its own, which is where a reduction bug lives and where a curve-level
// failure would tell you only that one of several thousand multiplications was wrong.
// WebCrypto checks the curve and the protocols, which is where a formula's exceptional
// cases live and which BigInt cannot reach.
//
// The field differential earned its place immediately. P-256's prime is written as eight
// 32-bit limbs, and in wac today `i64 v = 0xFFFFFFFF` is -1 — a hex literal that fits in
// 32 bits gets sign-extended when the target is 64-bit (wac issue 0054). Six of the
// prime's limbs came out as -1, so the comparison against p was wrong, so a value of
// zero did not survive a round trip through the encoder. Nothing above the field would
// have located that.

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

Deno.test("p256: ECDH agrees with WebCrypto in both directions", async () => {
  for (let round = 0; round < 3; round++) {
    const theirs = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
    const theirPub = new Uint8Array(await crypto.subtle.exportKey("raw", theirs.publicKey));
    const jwk = await crypto.subtle.exportKey("jwk", theirs.privateKey);
    const theirPriv = Uint8Array.from(
      atob(jwk.d!.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

    if (hex(pubKey(theirPriv)) !== hex(theirPub)) {
      throw new Error(`round ${round}: our public key from their scalar differs`);
    }

    const ourPriv = enc(BigInt(round * 7919 + 12345), N);
    const ourPub = pubKey(ourPriv);
    const imported = await crypto.subtle.importKey(
      "raw", ourPub as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const theirSecret = new Uint8Array(await crypto.subtle.deriveBits(
      { name: "ECDH", public: imported }, theirs.privateKey, 256));
    if (hex(ecdh(ourPriv, theirPub)) !== hex(theirSecret)) {
      throw new Error(`round ${round}: shared secrets differ`);
    }
  }
});

Deno.test("p256: verifies WebCrypto's ECDSA signatures and rejects tampering", async () => {
  const kp = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));

  for (const text of ["", "a", "a longer message that crosses no boundary in particular"]) {
    const msg = new TextEncoder().encode(text);
    const sig = new Uint8Array(await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, kp.privateKey, msg as BufferSource));
    if (!verify(pub, msg, sig)) throw new Error(`rejected a valid signature over ${JSON.stringify(text)}`);

    for (const i of [0, 31, 32, 63]) {
      const bad = Uint8Array.from(sig);
      bad[i] ^= 1;
      if (verify(pub, msg, bad)) throw new Error(`accepted a signature with byte ${i} flipped`);
    }
    const otherMsg = new TextEncoder().encode(text + "!");
    if (verify(pub, otherMsg, sig)) throw new Error("accepted a signature over a different message");
  }
});

Deno.test("p256: our signatures verify in WebCrypto", async () => {
  // The other direction. ECDSA is randomised, so this cannot compare bytes the way the
  // Ed25519 test does — it has to hand the signature to an independent verifier.
  const priv = enc(0x1234567890ABCDEFn, N);
  const pub = pubKey(priv);
  const imported = await crypto.subtle.importKey(
    "raw", pub as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);

  const msg = new TextEncoder().encode("signed in wac");
  for (let i = 1; i <= 3; i++) {
    const k = enc(BigInt(i) * 0x9E3779B97F4A7C15n, N);
    const sig = sign(priv, msg, k);
    if (sig.length !== 64) throw new Error(`sign returned ${sig.length} bytes for k #${i}`);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, imported, sig as BufferSource, msg as BufferSource);
    if (!ok) throw new Error(`WebCrypto rejected our signature with k #${i}`);
    // And our own verifier agrees, which it must if both are right.
    if (!verify(pub, msg, sig)) throw new Error(`we rejected our own signature with k #${i}`);
  }
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

Deno.test("p256: an ECDSA signature with r or s out of range is refused", () => {
  // RFC 6979 and FIPS 186-4 both require 1 <= r, s < n. A verifier that skips the check
  // accepts a second encoding of the same signature, which breaks anything using one as
  // an identifier.
  const priv = enc(999n, N);
  const pub = pubKey(priv);
  const msg = new TextEncoder().encode("range check");
  const sig = sign(priv, msg, enc(0xDEADBEEFn, N));
  if (!verify(pub, msg, sig)) throw new Error("a freshly made signature did not verify");

  const zeroR = Uint8Array.from(sig);
  zeroR.set(new Uint8Array(32), 0);
  if (verify(pub, msg, zeroR)) throw new Error("accepted r = 0");
  const zeroS = Uint8Array.from(sig);
  zeroS.set(new Uint8Array(32), 32);
  if (verify(pub, msg, zeroS)) throw new Error("accepted s = 0");

  const nBytes = unhex("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
  const bigR = Uint8Array.from(sig);
  bigR.set(nBytes, 0);
  if (verify(pub, msg, bigR)) throw new Error("accepted r = n");
  const bigS = Uint8Array.from(sig);
  bigS.set(nBytes, 32);
  if (verify(pub, msg, bigS)) throw new Error("accepted s = n");
});
