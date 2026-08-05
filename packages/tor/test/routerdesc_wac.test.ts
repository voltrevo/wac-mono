// Registers the wac-side proposal 228 tests: the curve25519 -> ed25519 conversion that
// `ntor-onion-key-crosscert` is built on.
//
// The oracle is `test/data/routerdesc_vectors.json` — eight router descriptors from tor's own
// `src/test/test_descriptors.inc`. Every input is C tor's: the curve25519 onion key, the sign bit,
// the certificate signed by the converted key, and the identity it certifies. Nothing in the chain
// was produced here, so a conversion that agrees with them agrees with tor.
//
// **Node verifies the signature, not us.** `ed25519Verify` in this repo is perfectly good and it is
// the wrong tool here: using it would mean our conversion feeding our verifier, and the pair can
// agree on a wrong answer — a formula that consistently produced the negation of the right key would
// pass, because our verifier would be handed the same wrong key both times. node:crypto did not
// produce these certificates and does not share code with us, so it can only agree if the key is
// actually right. The wac test additionally asks our own verifier for the same answer, which is worth
// something once the host has established what the answer is.
//
// Both sign-bit values appear across the eight descriptors, so a conversion that ignored the bit
// fails on half of them rather than passing by luck.
//
// **The second oracle** is `data/prop228_vectors.json`, which comes from calling tor's own
// `ed25519_keypair_from_curve25519_keypair` — see `tools/capture-prop228.py`. The descriptors cannot
// reach the secret side of the derivation: the string it hashes contributes only the nonce prefix, and
// no public key depends on the prefix. Tor's committed test data does not cover it either. So that
// file carries tor's expanded secret and a signature tor made with it, and because ed25519 is
// deterministic the signature pins all 64 bytes — derivation string and terminating NUL included.

import { createPublicKey, verify as nodeEd25519Verify } from "node:crypto";
import { wacTestRun } from "../../../harness/wacTestRun.ts";

const V_COUNT = 0;
const V_NTOR = 1; // a[0]=i: the curve25519 onion key
const V_SIGNBIT = 2; // a[0]=i: the sign bit the descriptor states
const V_CROSSCERT = 3; // a[0]=i: the ntor-onion-key-crosscert, body and signature
const V_MASTER = 4; // a[0]=i: the master ed25519 identity it certifies
const V_HOST_VERIFY = 5; // a = a 32-byte public key, b = a certificate; [1] if node accepts it

// The second vector file: tor's own derivation, taken by calling tor. See capture-prop228.py.
const P_COUNT = 6;
const P_CURVE_SECRET = 7; // a[0]=i
const P_CURVE_PUBLIC = 8; // a[0]=i
const P_EXPANDED = 9; // a[0]=i: the 64-byte secret tor derived
const P_ED_PUBLIC = 10; // a[0]=i
const P_SIGNBIT = 11; // a[0]=i
const P_SIGNATURE = 12; // a[0]=i: tor's signature over P_MESSAGE with the derived key
const P_MESSAGE = 13;

const v = JSON.parse(
  await Deno.readTextFile(new URL("data/routerdesc_vectors.json", import.meta.url)),
) as {
  descriptors: {
    nickname: string;
    ntor_onion_key: string;
    signbit: number;
    ntor_crosscert: string;
    master_key_ed25519: string;
  }[];
};

const p = JSON.parse(
  await Deno.readTextFile(new URL("data/prop228_vectors.json", import.meta.url)),
) as {
  message: string;
  cases: {
    curve_secret: string;
    curve_public: string;
    expanded: string;
    ed_public: string;
    signbit: number;
    signature: string;
  }[];
};

if (p.cases.length < 1) throw new Error("prop228 vectors are empty");

if (v.descriptors.length < 4) {
  throw new Error(`expected several descriptors, found ${v.descriptors.length}`);
}
if (!v.descriptors.some((d) => d.signbit === 0) || !v.descriptors.some((d) => d.signbit === 1)) {
  throw new Error("the vectors must include both sign bits, or the bit is never tested");
}

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

// SubjectPublicKeyInfo for Ed25519: SEQUENCE { SEQUENCE { OID 1.3.101.112 }, BIT STRING }. node will
// not take a raw 32-byte key, and wrapping it is cheaper than depending on a key-parsing library.
const SPKI_PREFIX = hex("302a300506032b6570032100");

/** Verify a certificate under `pub` using node's Ed25519 — the whole point is that it is not ours. */
function hostVerify(pub: Uint8Array, cert: Uint8Array): boolean {
  if (pub.length !== 32 || cert.length <= 64) return false;
  const body = cert.subarray(0, cert.length - 64);
  const sig = cert.subarray(cert.length - 64);
  try {
    const key = createPublicKey({
      key: new Uint8Array([...SPKI_PREFIX, ...pub]) as unknown as Buffer,
      format: "der",
      type: "spki",
    });
    return nodeEd25519Verify(null, body, key, sig);
  } catch {
    return false;
  }
}

function ref(what: number, a: Uint8Array, b: Uint8Array): Uint8Array {
  switch (what) {
    case V_COUNT:
      return new Uint8Array([v.descriptors.length]);
    case V_NTOR:
      return hex(v.descriptors[a[0]].ntor_onion_key);
    case V_SIGNBIT:
      return new Uint8Array([v.descriptors[a[0]].signbit]);
    case V_CROSSCERT:
      return hex(v.descriptors[a[0]].ntor_crosscert);
    case V_MASTER:
      return hex(v.descriptors[a[0]].master_key_ed25519);
    case V_HOST_VERIFY:
      return new Uint8Array([hostVerify(a, b) ? 1 : 0]);
    case P_COUNT:
      return new Uint8Array([p.cases.length]);
    case P_CURVE_SECRET:
      return hex(p.cases[a[0]].curve_secret);
    case P_CURVE_PUBLIC:
      return hex(p.cases[a[0]].curve_public);
    case P_EXPANDED:
      return hex(p.cases[a[0]].expanded);
    case P_ED_PUBLIC:
      return hex(p.cases[a[0]].ed_public);
    case P_SIGNBIT:
      return new Uint8Array([p.cases[a[0]].signbit]);
    case P_SIGNATURE:
      return hex(p.cases[a[0]].signature);
    case P_MESSAGE:
      return new TextEncoder().encode(p.message);
    default:
      throw new Error(`unknown vector field ${what}`);
  }
}

await wacTestRun("packages/tor/test/wac/routerdesc_test.wac", "routerdesc", [ref]);
