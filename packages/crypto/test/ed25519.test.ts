// Ed25519 against RFC 8032 and against WebCrypto.
//
// Signing and verifying are separately falsifiable and were separately wrong here, which
// is the argument for testing them apart rather than only round-tripping. The first
// version of this code produced every RFC 8032 signature correctly and failed to verify
// two of the three matching public keys: `sqrt(-1)` was computed with an exponent one
// short, so point *decoding* took the wrong branch for roughly half of all y-coordinates
// while point *encoding*, which never needs a square root, stayed perfect. A round-trip
// test — sign then verify with the same code — would have passed.
//
// So: published vectors for both directions independently, a differential against
// WebCrypto in both directions, and the rejection cases that RFC 8032 §5.1.7 requires.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/crypto/test/wac/curve25519_probe.wac");
const publicKey = mod.edPublicKey as (seed: Uint8Array) => Uint8Array;
const sign = mod.edSign as (seed: Uint8Array, msg: Uint8Array) => Uint8Array;
const verify = mod.edVerify as (pub: Uint8Array, msg: Uint8Array, sig: Uint8Array) => boolean;
const baseEncoded = mod.edBaseEncoded as () => Uint8Array;
const recode = mod.edRecode as (p: Uint8Array) => Uint8Array;

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) =>
  s.length === 0 ? new Uint8Array(0) : new Uint8Array(s.match(/../g)!.map(h => parseInt(h, 16)));

/** RFC 8032 §7.1: seed, public key, message, signature. */
const VECTORS: [string, string, string, string][] = [
  ["9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
   "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
   "",
   "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"],
  ["4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
   "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
   "72",
   "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"],
  ["c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
   "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
   "af82",
   "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a"],
  // The SHA(abc) case, whose message is 64 bytes — long enough to cross SHA-512's block
  // boundary inside the nonce and challenge hashes.
  ["833fe62409237b9d62ec77587520911e9a759cec1d19755b7da901b96dca3d42",
   "ec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf",
   "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a" +
   "2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
   "dc2a4459e7369633a52b1bf277839a00201009a3efbf3ecb69bea2186c26b589" +
   "09351fc9ac90b3ecfdfbc7c66431e0303dca179c138ac17ad9bef1177331a704"],
];

Deno.test("ed25519: the base point encodes as RFC 8032 says", () => {
  // Worth its own case because everything else depends on it, and because the base point
  // is derived here from y = 4/5 rather than written out — so this checks `recoverX`,
  // `sqrt(-1)`, the curve constant d, the encoding and field inversion in one line.
  const want = "5866666666666666666666666666666666666666666666666666666666666666";
  if (hex(baseEncoded()) !== want) throw new Error(`base point: ${hex(baseEncoded())}`);
});

Deno.test("ed25519: public keys match RFC 8032", () => {
  for (const [seed, pub] of VECTORS) {
    const got = hex(publicKey(unhex(seed)));
    if (got !== pub) throw new Error(`seed ${seed.slice(0, 16)}…\n  got  ${got}\n  want ${pub}`);
  }
});

Deno.test("ed25519: signatures match RFC 8032", () => {
  for (const [seed, , msg, sig] of VECTORS) {
    const got = hex(sign(unhex(seed), unhex(msg)));
    if (got !== sig) {
      throw new Error(`msg ${msg.slice(0, 16) || "(empty)"}\n  got  ${got}\n  want ${sig}`);
    }
  }
});

Deno.test("ed25519: verification accepts RFC 8032's signatures", () => {
  // Deliberately separate from the signing test. Verification exercises point *decoding*,
  // which signing never touches, and that is where this was wrong.
  for (const [, pub, msg, sig] of VECTORS) {
    if (!verify(unhex(pub), unhex(msg), unhex(sig))) {
      throw new Error(`rejected a valid signature for msg ${msg.slice(0, 16) || "(empty)"}`);
    }
  }
});

Deno.test("ed25519: point decoding round-trips every RFC public key", () => {
  // The narrowest statement of the bug that got past the signing tests: decode then
  // re-encode must be the identity. `edRecode` returns 0xFF-prefixed zeros on a failed
  // decode, so a rejection is visible rather than silently equal to something.
  for (const [, pub] of VECTORS) {
    const got = hex(recode(unhex(pub)));
    if (got !== pub) throw new Error(`recode(${pub.slice(0, 16)}…) = ${got}`);
  }
});

Deno.test("ed25519: agrees with WebCrypto in both directions", async () => {
  for (let round = 0; round < 4; round++) {
    const theirs = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const theirPub = new Uint8Array(await crypto.subtle.exportKey("raw", theirs.publicKey));
    // The last 32 bytes of a PKCS#8 Ed25519 key are the seed.
    const seed = new Uint8Array(await crypto.subtle.exportKey("pkcs8", theirs.privateKey)).slice(-32);

    if (hex(publicKey(seed)) !== hex(theirPub)) {
      throw new Error(`round ${round}: public key\n  ours   ${hex(publicKey(seed))}\n  theirs ${hex(theirPub)}`);
    }

    const msg = new TextEncoder().encode(`round ${round}: a message of some length to sign`);
    // Their signature must verify here — Ed25519 is deterministic, so it must also be
    // byte-identical to ours, which is a stronger check than verification alone.
    const theirSig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, theirs.privateKey, msg as BufferSource));
    const ourSig = sign(seed, msg);
    if (hex(ourSig) !== hex(theirSig)) {
      throw new Error(`round ${round}: signature\n  ours   ${hex(ourSig)}\n  theirs ${hex(theirSig)}`);
    }
    if (!verify(theirPub, msg, theirSig)) throw new Error(`round ${round}: rejected their signature`);
    // And ours must verify there.
    const ok = await crypto.subtle.verify({ name: "Ed25519" }, theirs.publicKey, ourSig as BufferSource, msg as BufferSource);
    if (!ok) throw new Error(`round ${round}: WebCrypto rejected our signature`);
  }
});

Deno.test("ed25519: rejects a tampered message, signature or key", () => {
  const [seed, pub, msg, sig] = VECTORS[2];
  const flip = (s: string, i: number) => {
    const b = unhex(s);
    b[i] ^= 1;
    return b;
  };
  if (verify(flip(pub, 0), unhex(msg), unhex(sig))) throw new Error("accepted a modified public key");
  if (verify(unhex(pub), flip(msg, 0), unhex(sig))) throw new Error("accepted a modified message");
  if (verify(unhex(pub), unhex(msg), flip(sig, 0))) throw new Error("accepted a modified R");
  if (verify(unhex(pub), unhex(msg), flip(sig, 32))) throw new Error("accepted a modified S");
  // An empty message is a legitimate input, not a tampering — vector 1 signs one — so a
  // message swapped for the empty string must fail on its merits.
  if (verify(unhex(pub), new Uint8Array(0), unhex(sig))) throw new Error("accepted an emptied message");
  // And the signature we produce for that seed must still verify, so the rejections
  // above are not a verifier that rejects everything.
  if (!verify(unhex(pub), unhex(msg), sign(unhex(seed), unhex(msg)))) {
    throw new Error("rejected a freshly made signature");
  }
});

Deno.test("ed25519: rejects a non-canonical S, which is what stops malleability", () => {
  // RFC 8032 §5.1.7: "if the signature's S is not in the range [0, L), the signature is
  // rejected". Without the check, S and S + L both verify, so a signature stops being a
  // unique token — anyone can produce a second valid encoding of someone else's
  // signature, which breaks any system using one as an identifier.
  const [, pub, msg, sig] = VECTORS[2];
  const L = 2n ** 252n + 27742317777372353535851937790883648493n;
  const s = unhex(sig).slice(32);
  let sv = 0n;
  for (let i = 31; i >= 0; i--) sv = (sv << 8n) | BigInt(s[i]);

  const withS = (v: bigint) => {
    const out = unhex(sig);
    let x = v;
    for (let i = 0; i < 32; i++) {
      out[32 + i] = Number(x & 0xFFn);
      x >>= 8n;
    }
    return out;
  };
  if (verify(unhex(pub), unhex(msg), withS(sv + L))) throw new Error("accepted S + L");
  if (verify(unhex(pub), unhex(msg), withS(L))) throw new Error("accepted S = L");
  // The unmodified S is below L and must still be accepted.
  if (!verify(unhex(pub), unhex(msg), withS(sv))) throw new Error("rejected the original S");
});

Deno.test("ed25519: rejects malformed keys and signatures", () => {
  const [, pub, msg, sig] = VECTORS[1];
  for (const n of [0, 31, 33, 64]) {
    if (verify(new Uint8Array(n), unhex(msg), unhex(sig))) throw new Error(`accepted a ${n}-byte key`);
  }
  for (const n of [0, 32, 63, 65]) {
    if (verify(unhex(pub), unhex(msg), new Uint8Array(n))) throw new Error(`accepted a ${n}-byte signature`);
  }
  // A y-coordinate with no corresponding x is not a point. 2 is such a y: y^2 - 1 over
  // d*y^2 + 1 is a non-residue, so nothing squares to it.
  const notAPoint = new Uint8Array(32);
  notAPoint[0] = 2;
  if (hex(recode(notAPoint))[0] !== "f") throw new Error("decoded a y-coordinate that is not on the curve");
});

Deno.test("ed25519: signs messages across SHA-512 block boundaries", async () => {
  // The nonce is H(prefix || msg) and the challenge is H(R || A || msg), so message
  // length shifts padding in two different hashes at two different offsets. WebCrypto
  // is the oracle; the lengths straddle 512-bit blocks from both directions.
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const seed = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey)).slice(-32);
  for (const n of [0, 1, 31, 32, 55, 56, 63, 64, 65, 127, 128, 200]) {
    const msg = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xFF);
    const want = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, msg as BufferSource));
    if (hex(sign(seed, msg)) !== hex(want)) throw new Error(`length ${n}: ${hex(sign(seed, msg))}`);
  }
});

Deno.test("ed25519: a seed that is not 32 bytes is refused, long as well as short", () => {
  // The same asymmetry as P-256's length guards. A short seed runs off the end of the
  // array inside expandSeed and wasm traps regardless, so the guard looks tested; a long
  // one is read for its first 32 bytes and the tail ignored, so `ed25519PublicKey` would
  // happily answer for a 33-byte "seed" and give the same key as its 32-byte prefix. Two
  // different inputs, one identity — which is the kind of thing that only ever surfaces
  // as a key that mysteriously already exists.
  const traps = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
  const msg = new TextEncoder().encode("seed lengths");
  const seed = Uint8Array.from({ length: 32 }, (_, i) => i);

  if (publicKey(seed).length !== 32) throw new Error("the genuine seed was rejected");
  for (const n of [0, 31, 33, 64]) {
    const bad = new Uint8Array(n);
    bad.set(seed.subarray(0, Math.min(n, 32)));
    if (!traps(() => publicKey(bad))) throw new Error(`accepted a ${n}-byte seed for a key`);
    if (!traps(() => sign(bad, msg))) throw new Error(`accepted a ${n}-byte seed for signing`);
  }
});
