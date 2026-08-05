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

import {
  constants, createPublicKey, publicDecrypt, verify as nodeEd25519Verify,
} from "node:crypto";
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

// The descriptor documents themselves, for the signature-digest tests.
const D_TEXT = 14; // a[0]=i: the whole descriptor, as tor wrote it
const D_IDENTITY_CERT = 15; // a[0]=i: identity-ed25519, whose certified key is the signing key
const D_ROUTER_SIG = 16; // a[0]=i: the 64 bytes of router-sig-ed25519
const D_RSA_RECOVER = 17; // a[0]=i: the digest node recovers from tor's own router-signature
const D_ONION_KEY_DER = 18; // a[0]=i: the onion-key PEM body, decoded
const D_ONION_KEY_PEM = 19; // a[0]=i: the onion-key PEM block exactly as tor wrote it
const D_FINGERPRINT_LINE = 20; // a[0]=i: the value on tor's own `fingerprint` line
const D_PUBLISHED_LINE = 21; // a[0]=i: the value on tor's own `published` line
const D_PUBLISHED_EPOCH = 22; // a[0]=i: that same time, as 8 big-endian bytes of epoch seconds
const D_NTOR_LINE = 23; // a[0]=i: the value on tor's own `ntor-onion-key` line
const D_SIGNING_N = 24; // a[0]=i: the modulus of the descriptor's own signing-key
const D_SIGNING_E = 25; // a[0]=i: its public exponent
const D_SIGNING_KEY_DER = 26; // a[0]=i: the signing-key DER exactly as tor published it

const v = JSON.parse(
  await Deno.readTextFile(new URL("data/routerdesc_vectors.json", import.meta.url)),
) as {
  descriptors: {
    nickname: string;
    descriptor: string;
    identity_ed25519_cert: string;
    router_sig_ed25519: string;
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

/**
 * The modulus and exponent of the descriptor's `signing-key`, unwrapped from its DER.
 *
 * `SEQUENCE { INTEGER n, INTEGER e }`, and the leading zero a positive INTEGER carries when its top
 * bit is set is stripped — the wac side is given magnitudes, and re-encoding is the thing under test.
 */
function rsaParts(desc: string): [Uint8Array, Uint8Array] {
  const body = pemAfter(desc, "signing-key", "RSA PUBLIC KEY");
  if (!body) return [new Uint8Array(0), new Uint8Array(0)];
  const der = Uint8Array.from(atob(body.replace(/\s/g, "")), (c) => c.charCodeAt(0));
  let i = 0;
  const len = () => {
    let n = der[i++];
    if (n & 0x80) {
      const k = n & 0x7f;
      n = 0;
      for (let j = 0; j < k; j++) n = n * 256 + der[i++];
    }
    return n;
  };
  if (der[i++] !== 0x30) return [new Uint8Array(0), new Uint8Array(0)];
  len();
  const readInt = () => {
    if (der[i++] !== 0x02) return new Uint8Array(0);
    const n = len();
    let start = i;
    let count = n;
    if (der[start] === 0 && count > 1) {
      start++;
      count--;
    }
    i += n;
    return der.subarray(start, start + count);
  };
  return [readInt(), readInt()];
}

/** The value on the line starting with `keyword`, or "". */
function line(text: string, keyword: string): string {
  return text.match(new RegExp(`^${keyword} (.+)$`, "m"))?.[1] ?? "";
}

/** The PEM body that follows `keyword` on its own line. */
function pemAfter(text: string, keyword: string, label: string): string | null {
  const re = new RegExp(
    `^${keyword}[^\\n]*\\n-----BEGIN ${label}-----\\n([\\s\\S]*?)-----END ${label}-----`,
    "m",
  );
  return text.match(re)?.[1] ?? null;
}

/**
 * The digest tor's `router-signature` actually covers, recovered with a public-key operation.
 *
 * The descriptor publishes the RSA identity as `signing-key`, and `router-signature` is that key
 * signing a bare SHA-1 digest with PKCS#1 padding and no DigestInfo — so recovering the payload is
 * the only way to see what was signed, and it makes tor's own signature the oracle for our span.
 * Returns empty if anything is missing, which the wac side asserts against.
 */
function recoverRouterSignature(desc: string): Uint8Array {
  const keyBody = pemAfter(desc, "signing-key", "RSA PUBLIC KEY");
  const sigBody = pemAfter(desc, "router-signature", "SIGNATURE");
  if (!keyBody || !sigBody) return new Uint8Array(0);
  try {
    const key = createPublicKey({
      key: `-----BEGIN RSA PUBLIC KEY-----\n${keyBody}-----END RSA PUBLIC KEY-----\n`,
      format: "pem",
      type: "pkcs1",
    });
    const sig = Uint8Array.from(atob(sigBody.replace(/\s/g, "")), (c) => c.charCodeAt(0));
    return new Uint8Array(publicDecrypt({ key, padding: constants.RSA_PKCS1_PADDING }, sig));
  } catch {
    return new Uint8Array(0);
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
    case D_TEXT:
      return new TextEncoder().encode(v.descriptors[a[0]].descriptor);
    case D_IDENTITY_CERT:
      return hex(v.descriptors[a[0]].identity_ed25519_cert);
    case D_ROUTER_SIG: {
      // tor writes these base64 without padding.
      const t = v.descriptors[a[0]].router_sig_ed25519;
      return Uint8Array.from(atob(t + "=".repeat((4 - t.length % 4) % 4)), (c) => c.charCodeAt(0));
    }
    case D_RSA_RECOVER:
      return recoverRouterSignature(v.descriptors[a[0]].descriptor);
    case D_ONION_KEY_DER: {
      const body = pemAfter(v.descriptors[a[0]].descriptor, "onion-key", "RSA PUBLIC KEY");
      if (!body) return new Uint8Array(0);
      return Uint8Array.from(atob(body.replace(/\s/g, "")), (c) => c.charCodeAt(0));
    }
    case D_ONION_KEY_PEM: {
      const body = pemAfter(v.descriptors[a[0]].descriptor, "onion-key", "RSA PUBLIC KEY");
      if (!body) return new Uint8Array(0);
      return new TextEncoder().encode(
        `-----BEGIN RSA PUBLIC KEY-----\n${body}-----END RSA PUBLIC KEY-----\n`,
      );
    }
    case D_FINGERPRINT_LINE:
      return new TextEncoder().encode(line(v.descriptors[a[0]].descriptor, "fingerprint"));
    case D_PUBLISHED_LINE:
      return new TextEncoder().encode(line(v.descriptors[a[0]].descriptor, "published"));
    case D_PUBLISHED_EPOCH: {
      // The descriptor writes UTC with no zone marker, so it has to be read as UTC explicitly.
      const t = line(v.descriptors[a[0]].descriptor, "published");
      const secs = Math.floor(Date.parse(t.replace(" ", "T") + "Z") / 1000);
      const out = new Uint8Array(8);
      for (let i = 7; i >= 0; i--) out[i] = (secs / 2 ** (8 * (7 - i))) & 0xff;
      return out;
    }
    case D_NTOR_LINE:
      return new TextEncoder().encode(line(v.descriptors[a[0]].descriptor, "ntor-onion-key"));
    case D_SIGNING_N:
      return rsaParts(v.descriptors[a[0]].descriptor)[0];
    case D_SIGNING_E:
      return rsaParts(v.descriptors[a[0]].descriptor)[1];
    case D_SIGNING_KEY_DER: {
      const body = pemAfter(v.descriptors[a[0]].descriptor, "signing-key", "RSA PUBLIC KEY");
      if (!body) return new Uint8Array(0);
      return Uint8Array.from(atob(body.replace(/\s/g, "")), (c) => c.charCodeAt(0));
    }
    default:
      throw new Error(`unknown vector field ${what}`);
  }
}

await wacTestRun("packages/tor/test/wac/routerdesc_test.wac", "routerdesc", [ref]);
