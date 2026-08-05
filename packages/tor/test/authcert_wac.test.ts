// Registers the wac-side authority key certificate tests.
//
// The vector in `data/authcert_generated.json` is a certificate this repo generated and tor's own
// `authority_cert_parse_from_string` accepted. The verdict has teeth: tor rejects the same document if
// either signature is disturbed, if the fingerprint line is altered, or — the case the source file
// warns about — if the two signatures are exchanged.
//
// The suite reproduces the bytes rather than running tor, for the reason `ntor_wac.test.ts` records:
// a differential that needs a built tor tree present reddens the shared suite for whoever has not got
// one. Regenerate with `src/gendesc.wac` and re-check with `tools/parsedesc-probe.c cert`.
//
// **node says which key signed what.** Byte-for-byte reproduction alone would not notice the two
// signatures being swapped, because the vector would have been generated with them swapped too. So the
// host recovers each signature's payload with the key that is supposed to have made it — the signing
// key for the crosscert, the identity key for the certification — and the wac side checks the payloads
// are the identity fingerprint and the document digest respectively. Those are 20-byte values that
// would not survive being produced by the wrong key.

import { constants, createPublicKey, publicDecrypt } from "node:crypto";
import { wacTestRun } from "../../../harness/wacTestRun.ts";

const A_KEY = 0; // a[0]=which of the six key values
const A_NUM = 1; // a[0]=0 published, 1 expires; 8 bytes big-endian
const A_CERT = 2; // the certificate itself
const A_RECOVER_CROSSCERT = 3; // a = signature bytes; the payload the *signing* key recovers
const A_RECOVER_CERTIFICATION = 4; // a = signature bytes; the payload the *identity* key recovers

const a = JSON.parse(
  await Deno.readTextFile(new URL("data/authcert_generated.json", import.meta.url)),
) as Record<string, string | number>;

const A_KEYS = ["identityN", "identityE", "identityD", "signingN", "signingE", "signingD"];

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

const be64 = (v: number) => {
  const out = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) out[i] = Math.floor(v / 2 ** (8 * (7 - i))) & 0xff;
  return out;
};

/** A DER `RSAPublicKey`, which is what node wants as `pkcs1` — built here rather than trusted. */
function derPublicKey(n: Uint8Array, e: Uint8Array): Uint8Array {
  const int = (m: Uint8Array) => {
    const body = m[0] & 0x80 ? new Uint8Array([0, ...m]) : m;
    return new Uint8Array([0x02, ...len(body.length), ...body]);
  };
  const len = (v: number): number[] => {
    if (v < 128) return [v];
    const bytes: number[] = [];
    for (let x = v; x > 0; x = Math.floor(x / 256)) bytes.unshift(x & 0xff);
    return [0x80 | bytes.length, ...bytes];
  };
  const body = new Uint8Array([...int(n), ...int(e)]);
  return new Uint8Array([0x30, ...len(body.length), ...body]);
}

function recoverWith(nHex: string, eHex: string, sig: Uint8Array): Uint8Array {
  try {
    const key = createPublicKey({
      key: derPublicKey(hex(nHex), hex(eHex)) as unknown as Buffer,
      format: "der",
      type: "pkcs1",
    });
    return new Uint8Array(publicDecrypt({ key, padding: constants.RSA_PKCS1_PADDING }, sig));
  } catch {
    return new Uint8Array(0);
  }
}

function ref(what: number, arg: Uint8Array, _b: Uint8Array): Uint8Array {
  switch (what) {
    case A_KEY:
      return hex(a[A_KEYS[arg[0]]] as string);
    case A_NUM:
      return be64(a[arg[0] === 0 ? "published" : "expires"] as number);
    case A_CERT:
      return new TextEncoder().encode(a.certificate as string);
    case A_RECOVER_CROSSCERT:
      return recoverWith(a.signingN as string, a.signingE as string, arg);
    case A_RECOVER_CERTIFICATION:
      return recoverWith(a.identityN as string, a.identityE as string, arg);
    default:
      throw new Error(`unknown vector field ${what}`);
  }
}

await wacTestRun("packages/tor/test/wac/authcert_test.wac", "authcert", [ref]);
