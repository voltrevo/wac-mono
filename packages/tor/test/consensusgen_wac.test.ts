// Registers the wac-side consensus tests.
//
// **The oracle here is split, deliberately.** tor's `networkstatus_parse_vote_from_string` accepted the
// committed document, and for a consensus that verdict covers structure and digests and *not*
// signatures — corrupting a `directory-signature` leaves a real consensus ACCEPTED, which is wac-mono
// issue 0081. A consensus cannot be self-verifying: its signatures come from authorities whose
// certificates a client fetches separately, so there is nothing in the document to check them against.
//
// So the signature is checked here instead, by node, with the key that should have made it. That is the
// same technique `authcert_wac.test.ts` uses to pin which key signs what, and it is arguably the better
// test of a *generator*: it says which key signed which bytes, where tor's own check would say only
// that some quorum of recognised authorities signed something.
//
// Between the two: tor says the document is well-formed, node says it is correctly signed over the span
// `vote_wac.test.ts` pinned against a chutney authority's own vote.

import { constants, createPublicKey, publicDecrypt } from "node:crypto";
import { wacTestRun } from "../../../harness/wacTestRun.ts";

const C_KEY = 0; // a[0]=which of the six authority key values
const C_STR = 1; // a[0]=which string field
const C_NUM = 2; // a[0]=which number, 8 bytes big-endian
const C_BYTES = 3; // a[0]=0 identityDigest, 1 voteDigest
const C_DESC = 4;
const C_CONSENSUS = 5;
const C_RECOVERED = 6; // a = signature bytes; what the signing key recovers from them

const c = JSON.parse(
  await Deno.readTextFile(new URL("data/consensus_generated.json", import.meta.url)),
) as Record<string, string | number>;

const C_KEYS = ["identityN", "identityE", "identityD", "signingN", "signingE", "signingD"];
const C_STRS = ["nickname", "address", "ip", "contact", "flags", "exitPolicy", "bandwidthWeights"];
const C_NUMS = [
  "dirPort", "orPort", "consensusMethod", "validAfter", "freshUntil", "validUntil",
  "voteSeconds", "distSeconds", "bandwidth",
];

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

const be64 = (v: number) => {
  const out = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) out[i] = Math.floor(v / 2 ** (8 * (7 - i))) & 0xff;
  return out;
};

/** A DER RSAPublicKey, built rather than trusted, so node can be handed the signing key. */
function derPublicKey(n: Uint8Array, e: Uint8Array): Uint8Array {
  const len = (v: number): number[] => {
    if (v < 128) return [v];
    const bytes: number[] = [];
    for (let x = v; x > 0; x = Math.floor(x / 256)) bytes.unshift(x & 0xff);
    return [0x80 | bytes.length, ...bytes];
  };
  const int = (m: Uint8Array) => {
    const body = m[0] & 0x80 ? new Uint8Array([0, ...m]) : m;
    return new Uint8Array([0x02, ...len(body.length), ...body]);
  };
  const body = new Uint8Array([...int(n), ...int(e)]);
  return new Uint8Array([0x30, ...len(body.length), ...body]);
}

/** What the *signing* key recovers from a signature. Empty if it was not that key's work. */
function recovered(sig: Uint8Array): Uint8Array {
  try {
    const key = createPublicKey({
      key: derPublicKey(hex(c.signingN as string), hex(c.signingE as string)) as unknown as Buffer,
      format: "der",
      type: "pkcs1",
    });
    return new Uint8Array(publicDecrypt({ key, padding: constants.RSA_PKCS1_PADDING }, sig));
  } catch {
    return new Uint8Array(0);
  }
}

function ref(what: number, a: Uint8Array, _b: Uint8Array): Uint8Array {
  switch (what) {
    case C_KEY:
      return hex(c[C_KEYS[a[0]]] as string);
    case C_STR:
      return new TextEncoder().encode(c[C_STRS[a[0]]] as string);
    case C_NUM:
      return be64(c[C_NUMS[a[0]]] as number);
    case C_BYTES:
      return hex(c[a[0] === 0 ? "identityDigest" : "voteDigest"] as string);
    case C_DESC:
      return new TextEncoder().encode(c.descriptor as string);
    case C_CONSENSUS:
      return new TextEncoder().encode(c.consensus as string);
    case C_RECOVERED:
      return recovered(a);
    default:
      throw new Error(`unknown vector field ${what}`);
  }
}

await wacTestRun("packages/tor/test/wac/consensusgen_test.wac", "consensusgen", [ref]);
