// Registers the wac-side relay certificate tests.
//
// Two sources of truth, and neither is ours:
//
//   - `test/data/relaycert_vectors.json` holds four ed25519 signing certificates tor generated on a
//     chutney network. Our verifier must accept all four, which is what pins the signature span.
//   - node:crypto supplies an RSA-1024 keypair and verifies the type-7 cross-certificate we build,
//     so the RSA half is checked by something that did not produce it.
//
// RSA-1024 because that is what a Tor identity key is. node will generate one; it is a throwaway,
// and `packages/crypto/src/rsa.wac` says at length what these keys are and are not for.

import { constants, createPrivateKey, generateKeyPairSync, publicDecrypt } from "node:crypto";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { wacTestRun } from "../../../harness/wacTestRun.ts";

const V_COUNT = 0, V_CERT = 1, V_MASTER = 2, V_RSA_N = 3, V_RSA_D = 4, V_VERIFY_CROSSCERT = 5;
// A second RSA key, standing in for the TAP onion key, and the recovery of what it signed. The onion
// key has to be a different key from the identity: `onion-key-crosscert` exists to bind two keys
// together, and a test that used one key for both would pass with the roles swapped.
const V_ONION_N = 6, V_ONION_D = 7, V_RECOVER_ONION = 8;

const v = JSON.parse(
  await Deno.readTextFile(new URL("data/relaycert_vectors.json", import.meta.url)),
) as { cases: { nickname: string; masterIdentity: string; signingCert: string }[] };

if (v.cases.length < 3) throw new Error(`expected several certificates, found ${v.cases.length}`);

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 });
const jwk = rsa.privateKey.export({ format: "jwk" }) as Record<string, string>;
const b64 = (s: string) =>
  new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
const N = b64(jwk.n), D = b64(jwk.d);

const onion = generateKeyPairSync("rsa", { modulusLength: 1024 });
const onionJwk = onion.privateKey.export({ format: "jwk" }) as Record<string, string>;
const ONION_N = b64(onionJwk.n), ONION_D = b64(onionJwk.d);

/** Recover what the onion key signed. Empty if the signature is not a PKCS#1 block under that key. */
function recoverOnion(sig: Uint8Array): Uint8Array {
  try {
    return new Uint8Array(
      publicDecrypt({ key: onion.publicKey, padding: constants.RSA_PKCS1_PADDING }, sig),
    );
  } catch {
    return new Uint8Array(0);
  }
}

const CROSSCERT_PREFIX = new TextEncoder().encode("Tor TLS RSA/Ed25519 cross-certificate");

/** Verify a type-7 cross-certificate the way a relay would: recover the digest and compare. */
function verifyCrossCert(cert: Uint8Array): boolean {
  if (cert.length < 37) return false;
  const sigLen = cert[36];
  if (cert.length !== 37 + sigLen) return false;
  const signed = new Uint8Array([...CROSSCERT_PREFIX, ...cert.subarray(0, 36)]);
  const want = new Uint8Array(createHash("sha256").update(signed).digest());
  let recovered: Uint8Array;
  try {
    // `RSA_public_decrypt` with PKCS#1 padding is the verify primitive: it requires block type 1 and
    // returns the payload. Tor signs a bare digest with no DigestInfo, so there is nothing for
    // `createVerify` to match against and this is the only way to check it.
    recovered = new Uint8Array(
      publicDecrypt({ key: rsa.publicKey, padding: constants.RSA_PKCS1_PADDING },
        cert.subarray(37)),
    );
  } catch {
    return false;
  }
  return recovered.length === want.length && recovered.every((b, i) => b === want[i]);
}

function ref(what: number, a: Uint8Array, _b: Uint8Array): Uint8Array {
  switch (what) {
    case V_COUNT:
      return new Uint8Array([v.cases.length]);
    case V_CERT:
      return hex(v.cases[a[0]].signingCert);
    case V_MASTER:
      return hex(v.cases[a[0]].masterIdentity);
    case V_RSA_N:
      return N;
    case V_RSA_D:
      return D;
    case V_VERIFY_CROSSCERT:
      return new Uint8Array([verifyCrossCert(a) ? 1 : 0]);
    case V_ONION_N:
      return ONION_N;
    case V_ONION_D:
      return ONION_D;
    case V_RECOVER_ONION:
      return recoverOnion(a);
    default:
      throw new Error(`unknown vector field ${what}`);
  }
}

await wacTestRun("packages/tor/test/wac/relaycert_test.wac", "relaycert", [ref]);
