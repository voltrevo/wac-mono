// RSA's modular exponentiation against BigInt.
//
// The signature verification — PKCS#1 v1.5, PSS at every salt length, and the tampering
// each must refuse — moved to `test/wac/rsa_test.wac`, where node signs and we check.
//
// This stayed for the reason field25519 documents: the bignum underneath is checked by an
// outside reference because a self-consistent representative satisfies every relation the
// arithmetic can state about itself. modPow is also the one part with no protocol shape
// to test it through — a signature that verifies says the exponentiation was right for
// that input, and nothing about the carries a hundred limbs up.

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





