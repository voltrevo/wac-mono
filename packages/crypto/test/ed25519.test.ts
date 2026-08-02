// Ed25519's malformed-input refusals.
//
// Only the refusals. RFC 8032's vectors, byte-identical agreement with node, tampering,
// the non-canonical S that stops malleability, the low-order cases and the x = 0 encoding
// all moved to `test/wac/curve25519_test.wac`.
//
// These stayed because they trap. The seed length is the one worth keeping sharp: a short
// seed runs off the end of the array and traps regardless, but a long one is read for its
// first 32 bytes and the tail ignored — so without the check a 33-byte "seed" produces the
// same key as its prefix, and two different inputs have one identity.

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
