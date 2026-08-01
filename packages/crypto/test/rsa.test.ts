// RSA signature verification, against WebCrypto.
//
// There is no signing here to round-trip against, which is the right shape for a
// verifier and makes the test structure straightforward: WebCrypto produces signatures,
// we accept the good ones and refuse everything else.
//
// The refusals carry most of the value. RSA's history is a list of verifiers that
// searched for the padding structure instead of requiring it — Bleichenbacher's 2006
// forgery worked against implementations that parsed the DigestInfo rather than matching
// its bytes, and against ones that stopped checking after finding the hash. Accepting a
// signature is easy; the whole job is refusing everything that is not exactly right.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/crypto/test/wac/rsa_probe.wac");
const verifyPkcs1 = mod.verifyPkcs1 as (
  n: Uint8Array, e: Uint8Array, msg: Uint8Array, sig: Uint8Array, hashLen: number) => boolean;
const verifyPss = mod.verifyPss as (
  n: Uint8Array, e: Uint8Array, msg: Uint8Array, sig: Uint8Array, hashLen: number, saltLen: number) => boolean;
const modExp = mod.modExp as (b: Uint8Array, e: Uint8Array, n: Uint8Array) => Uint8Array;

const enc = new TextEncoder();
const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
const b64u = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

function be(v: bigint, len: number): Uint8Array {
  const o = new Uint8Array(len);
  let x = v;
  for (let i = len - 1; i >= 0; i--) {
    o[i] = Number(x & 0xFFn);
    x >>= 8n;
  }
  return o;
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

/** A public key, and signatures over one message, from WebCrypto. */
async function keyFor(name: "RSASSA-PKCS1-v1_5" | "RSA-PSS", hash: string, bits = 2048) {
  const kp = await crypto.subtle.generateKey(
    { name, modulusLength: bits, publicExponent: new Uint8Array([1, 0, 1]), hash },
    true, ["sign", "verify"]) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  return { kp, n: b64u(jwk.n!), e: b64u(jwk.e!) };
}

Deno.test("rsa: modular exponentiation agrees with BigInt", () => {
  // Everything rests on this, and it is the one piece that can be checked without a key.
  const cases: [bigint, bigint, bigint][] = [
    [3n, 5n, 7n],
    [2n, 65537n, 3233n],
    [0n, 65537n, 3233n],
    [1n, 65537n, 3233n],
    [123456789n, 65537n, (1n << 127n) - 1n],
    // A base larger than the modulus, which must be reduced first.
    [(1n << 200n) + 7n, 3n, (1n << 61n) - 1n],
    // An even modulus, which divmod must still handle.
    [12345n, 17n, 1n << 64n],
  ];
  for (const [b, e, m] of cases) {
    const got = BigInt("0x" + hex(modExp(be(b, 32), be(e, 32), be(m, 32))));
    const want = modPow(b, e, m);
    if (got !== want) throw new Error(`${b}^${e} mod ${m} = ${got}, want ${want}`);
  }
});

Deno.test("rsa: verifies PKCS#1 v1.5 signatures from WebCrypto", async () => {
  for (const [hash, hashLen] of [["SHA-256", 32], ["SHA-384", 48], ["SHA-512", 64]] as const) {
    const { kp, n, e } = await keyFor("RSASSA-PKCS1-v1_5", hash);
    for (const text of ["", "short", "a message long enough to span a hash block or two ".repeat(3)]) {
      const msg = enc.encode(text);
      const sig = new Uint8Array(await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5", kp.privateKey, msg as BufferSource));
      if (!verifyPkcs1(n, e, msg, sig, hashLen)) {
        throw new Error(`${hash}: rejected a valid signature over ${JSON.stringify(text.slice(0, 20))}`);
      }
    }
  }
});

Deno.test("rsa: refuses everything that is not exactly the right PKCS#1 block", async () => {
  const { kp, n, e } = await keyFor("RSASSA-PKCS1-v1_5", "SHA-256");
  const msg = enc.encode("the message");
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, msg as BufferSource));
  if (!verifyPkcs1(n, e, msg, sig, 32)) throw new Error("rejected the genuine signature");

  // A flipped bit anywhere in the signature.
  for (const i of [0, 1, 100, 255]) {
    const bad = Uint8Array.from(sig);
    bad[i] ^= 1;
    if (verifyPkcs1(n, e, msg, bad, 32)) throw new Error(`accepted a signature with byte ${i} flipped`);
  }
  // A different message.
  if (verifyPkcs1(n, e, enc.encode("the messagf"), sig, 32)) {
    throw new Error("accepted a signature over a different message");
  }
  // The wrong hash length, which changes the DigestInfo prefix that must match.
  if (verifyPkcs1(n, e, msg, sig, 48)) throw new Error("accepted the wrong DigestInfo prefix");
  // A signature of the wrong length is not a signature. `Math.min` here was a mistake
  // the first time: clamping 257 to the signature's own length handed the verifier the
  // genuine signature and then demanded a refusal.
  for (const len of [0, 255, 257]) {
    const wrong = new Uint8Array(len);
    wrong.set(sig.subarray(0, Math.min(len, sig.length)));
    if (verifyPkcs1(n, e, msg, wrong, 32)) throw new Error(`accepted a ${len}-byte signature`);
  }
  // A signature numerically at or above the modulus. `s = n` recovers zero, which cannot
  // be a valid block, but the range check should refuse it before doing the work.
  if (verifyPkcs1(n, e, msg, n, 32)) throw new Error("accepted s = n");
  // A different key must not verify it.
  const other = await keyFor("RSASSA-PKCS1-v1_5", "SHA-256");
  if (verifyPkcs1(other.n, other.e, msg, sig, 32)) throw new Error("accepted under the wrong key");
});

Deno.test("rsa: verifies PSS signatures at every salt length WebCrypto will produce", async () => {
  const { kp, n, e } = await keyFor("RSA-PSS", "SHA-256");
  const msg = enc.encode("verify me with pss");
  // TLS always uses a salt the length of the hash; the others are here because the
  // padding arithmetic depends on the salt length and a formula that is right for one
  // value is not obviously right for the rest.
  for (const saltLength of [0, 1, 20, 32]) {
    const sig = new Uint8Array(await crypto.subtle.sign(
      { name: "RSA-PSS", saltLength }, kp.privateKey, msg as BufferSource));
    if (!verifyPss(n, e, msg, sig, 32, saltLength)) {
      throw new Error(`rejected a valid PSS signature with saltLen ${saltLength}`);
    }
    // And the same signature must fail when checked against a different salt length,
    // since that changes where the salt is expected to start.
    if (saltLength !== 32 && verifyPss(n, e, msg, sig, 32, 32)) {
      throw new Error(`a saltLen ${saltLength} signature verified as saltLen 32`);
    }
  }
});

Deno.test("rsa: refuses tampered PSS signatures", async () => {
  const { kp, n, e } = await keyFor("RSA-PSS", "SHA-256");
  const msg = enc.encode("pss rejections");
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: "RSA-PSS", saltLength: 32 }, kp.privateKey, msg as BufferSource));
  if (!verifyPss(n, e, msg, sig, 32, 32)) throw new Error("rejected the genuine signature");

  for (const i of [0, 5, 128, 255]) {
    const bad = Uint8Array.from(sig);
    bad[i] ^= 1;
    if (verifyPss(n, e, msg, bad, 32, 32)) throw new Error(`accepted PSS with byte ${i} flipped`);
  }
  if (verifyPss(n, e, enc.encode("other"), sig, 32, 32)) {
    throw new Error("accepted PSS over a different message");
  }
  // The trailing byte must be 0xBC. Nothing else in the block moves when it changes, so
  // a verifier that skipped this check would still accept.
  const badTrailer = Uint8Array.from(sig);
  badTrailer[badTrailer.length - 1] ^= 0xFF;
  if (verifyPss(n, e, msg, badTrailer, 32, 32)) throw new Error("accepted a wrong trailer byte");

  const other = await keyFor("RSA-PSS", "SHA-256");
  if (verifyPss(other.n, other.e, msg, sig, 32, 32)) throw new Error("accepted PSS under the wrong key");
});

Deno.test("rsa: works at 3072 bits as well as 2048", async () => {
  // Key size changes the padding length and the number of MGF1 blocks, both of which are
  // computed rather than assumed.
  const { kp, n, e } = await keyFor("RSA-PSS", "SHA-256", 3072);
  const msg = enc.encode("a larger modulus");
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: "RSA-PSS", saltLength: 32 }, kp.privateKey, msg as BufferSource));
  if (!verifyPss(n, e, msg, sig, 32, 32)) throw new Error("rejected a valid 3072-bit PSS signature");

  const pk = await keyFor("RSASSA-PKCS1-v1_5", "SHA-256", 3072);
  const sig2 = new Uint8Array(await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", pk.kp.privateKey, msg as BufferSource));
  if (!verifyPkcs1(pk.n, pk.e, msg, sig2, 32)) {
    throw new Error("rejected a valid 3072-bit PKCS#1 signature");
  }
});
