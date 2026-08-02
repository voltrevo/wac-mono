// Registers the wac-side RSA tests and supplies node's signer.
//
// Key generation is slow — a fresh 3072-bit key is a second or so — so each size is
// generated once and reused across the tests that ask for it. The last key generated is
// also the one the signing modes use, which is why every test asks for its key before it
// asks for a signature.
import { createSign, generateKeyPairSync, type KeyPairKeyObjectResult } from "node:crypto";
import { Buffer } from "node:buffer";
import { wacTestRun } from "../../../harness/wacTestRun.ts";

const KEYGEN = 0, SIGN_PKCS1 = 1, SIGN_PSS = 2;
// Named outright rather than as `ReturnType<typeof generateKeyPairSync<"rsa">>`: that spelling
// asks an overloaded function to be instantiated with a type argument, and none of the overloads
// accepts one, so it fails to type-check. `deno test` type-checks by default, so it fails the
// whole run. Same family as the `authTagLength` overload in `aes_wac.test.ts` — see 0011.
const keys = new Map<number, KeyPairKeyObjectResult>();
let current = 2048;

/** The modulus without its DER sign byte, and the exponent, as raw big-endian bytes. */
function parts(bits: number): { n: Uint8Array; e: Uint8Array } {
  const jwk = keys.get(bits)!.publicKey.export({ format: "jwk" }) as { n: string; e: string };
  const b64 = (s: string) =>
    new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
  return { n: b64(jwk.n), e: b64(jwk.e) };
}

function ref(mode: number, a: Uint8Array, b: Uint8Array): Uint8Array {
  if (mode === KEYGEN) {
    const bits = (a[0] << 8) | a[1];
    current = bits;
    if (!keys.has(bits)) {
      keys.set(bits, generateKeyPairSync("rsa", { modulusLength: bits }));
    }
    const { n, e } = parts(bits);
    // Length-prefixed, because a callback returns one array and the two halves have
    // different sizes.
    return new Uint8Array([n.length >> 8, n.length & 0xFF, ...n, ...e]);
  }
  const hashLen = a[0];
  const algo = hashLen === 32 ? "sha256" : hashLen === 48 ? "sha384" : "sha512";
  const s = createSign(algo);
  s.update(b);
  if (mode === SIGN_PKCS1) {
    return new Uint8Array(s.sign(keys.get(current)!.privateKey));
  }
  return new Uint8Array(s.sign({
    key: keys.get(current)!.privateKey,
    padding: 6,                       // RSA_PKCS1_PSS_PADDING
    saltLength: a[1],
  }));
}

await wacTestRun("packages/crypto/test/wac/rsa_test.wac", "rsa", [ref]);
