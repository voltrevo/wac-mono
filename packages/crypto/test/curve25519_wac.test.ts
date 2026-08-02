// Registers the wac-side X25519 and Ed25519 tests and supplies node's implementations.
//
// Both are synchronous in node:crypto where WebCrypto's are promises, which is what lets
// them be callbacks at all. Raw keys have to be wrapped in the DER these APIs expect —
// the prefixes below are the fixed PKCS#8 and SPKI headers for the two algorithms, which
// are constant because the key size is.
import { createPrivateKey, createPublicKey, diffieHellman, sign, verify } from "node:crypto";
import { Buffer } from "node:buffer";
import { wacTestRun } from "../../../harness/wacTestRun.ts";

const ED_PUB = 0, ED_SIGN = 1, ED_VERIFY = 2, X_BASE = 3, X_SHARED = 4;

const wrap = (prefix: string, raw: Uint8Array) =>
  Buffer.concat([Buffer.from(prefix, "hex"), Buffer.from(raw)]);

const edPriv = (seed: Uint8Array) =>
  createPrivateKey({ key: wrap("302e020100300506032b657004220420", seed), format: "der", type: "pkcs8" });
const edPub = (pub: Uint8Array) =>
  createPublicKey({ key: wrap("302a300506032b6570032100", pub), format: "der", type: "spki" });
const xPriv = (priv: Uint8Array) =>
  createPrivateKey({ key: wrap("302e020100300506032b656e04220420", priv), format: "der", type: "pkcs8" });
const xPub = (pub: Uint8Array) =>
  createPublicKey({ key: wrap("302a300506032b656e032100", pub), format: "der", type: "spki" });

/** The last 32 bytes of an SPKI export are the raw point. */
const rawPub = (k: ReturnType<typeof createPublicKey>) =>
  new Uint8Array((k.export({ type: "spki", format: "der" }) as Buffer).subarray(-32));

function ref(mode: number, a: Uint8Array, b: Uint8Array): Uint8Array {
  if (mode === ED_PUB) return rawPub(createPublicKey(edPriv(a)));
  if (mode === ED_SIGN) return new Uint8Array(sign(null, b, edPriv(a)));
  if (mode === ED_VERIFY) {
    // `a` is the public key followed by the signature, since a callback takes two arrays.
    const ok = verify(null, b, edPub(a.subarray(0, 32)), a.subarray(32));
    return Uint8Array.from([ok ? 1 : 0]);
  }
  if (mode === X_BASE) return rawPub(createPublicKey(xPriv(a)));
  return new Uint8Array(diffieHellman({ privateKey: xPriv(a), publicKey: xPub(b) }));
}

await wacTestRun("packages/crypto/test/wac/curve25519_test.wac", "curve25519", [ref]);
