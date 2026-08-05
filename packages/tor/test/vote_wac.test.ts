// Registers the wac-side vote signature tests.
//
// A vote is self-verifying as a vector: it embeds the authority's key certificate, so the signing key
// that produced its `directory-signature` is inside the document. The host recovers the payload of
// that signature with that key and the wac side checks it against our digest — so tor's own signature
// over tor's own vote is what pins the span, with none of our code on the other side.
//
// The span is the reason this test exists. tor ends it at the space after `directory-signature`, where
// a router descriptor's RSA signature ends at the newline after `router-signature`. Same helper in
// tor, different terminator, and both of the other plausible spans produce a well-formed digest that
// matches nothing.

import { constants, createPublicKey, publicDecrypt } from "node:crypto";
import { wacTestRun } from "../../../harness/wacTestRun.ts";

const V_VOTE = 0;
const V_RECOVERED = 1; // the payload the embedded signing key recovers from the vote's signature
const V_DESC_COUNT = 2;
const V_DESCRIPTOR = 3; // a[0]=i: a relay's descriptor, in the vector's own arbitrary order
const V_R_LINES = 4; // every r line of the real vote, in document order, newline separated

// The vote this repo generated, which tor accepted — and for a vote, ACCEPTED means the signature
// verified: corrupting it, the embedded certificate, or one body byte are all rejected. So these bytes
// are a document a real tor checked, not merely parsed.
const G_KEY = 5; // a[0]=which of the six authority key values
const G_STR = 6; // a[0]=which string field
const G_NUM = 7; // a[0]=which number, 8 bytes big-endian
const G_CERT = 8;
const G_DESC = 9;
const G_VOTE = 10;

const v = JSON.parse(
  await Deno.readTextFile(new URL("data/vote_vectors.json", import.meta.url)),
) as { votes: { signingKeyDer: string; signature: string; vote: string }[] };

if (v.votes.length < 1) throw new Error("no vote in the vector");
const vote = v.votes[0];

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

// The same relays' descriptors, from the router-status vector. Kept separate because that vector is
// paired by digest and this one is a whole document; the two together are what let the ordering rule be
// checked against the order tor's authority actually wrote.
const rs = JSON.parse(
  await Deno.readTextFile(new URL("data/votestatus_vectors.json", import.meta.url)),
) as { cases: { descriptor: string; rLine: string }[] };

/** Every `r` line of the real vote, in the order the document has them. */
const realOrder = (vote.vote.match(/^r .+$/gm) ?? []).join("\n");

const g = JSON.parse(
  await Deno.readTextFile(new URL("data/vote_generated.json", import.meta.url)),
) as Record<string, string | number>;

const G_KEYS = ["identityN", "identityE", "identityD", "signingN", "signingE", "signingD"];
const G_STRS = ["nickname", "address", "ip", "contact", "flags", "exitPolicy"];
const G_NUMS = [
  "dirPort", "orPort", "published", "validAfter", "freshUntil", "validUntil",
  "voteSeconds", "distSeconds", "bandwidth",
];

const be64 = (v: number) => {
  const out = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) out[i] = Math.floor(v / 2 ** (8 * (7 - i))) & 0xff;
  return out;
};

/** What the authority's signing key says its `directory-signature` covers. */
function recovered(): Uint8Array {
  try {
    const key = createPublicKey({
      key: hex(vote.signingKeyDer) as unknown as Buffer,
      format: "der",
      type: "pkcs1",
    });
    return new Uint8Array(
      publicDecrypt({ key, padding: constants.RSA_PKCS1_PADDING }, hex(vote.signature)),
    );
  } catch {
    return new Uint8Array(0);
  }
}

function ref(what: number, _a: Uint8Array, _b: Uint8Array): Uint8Array {
  switch (what) {
    case V_VOTE:
      return new TextEncoder().encode(vote.vote);
    case V_RECOVERED:
      return recovered();
    case V_DESC_COUNT:
      return new Uint8Array([rs.cases.length]);
    case V_DESCRIPTOR:
      return new TextEncoder().encode(rs.cases[_a[0]].descriptor);
    case V_R_LINES:
      return new TextEncoder().encode(realOrder);
    case G_KEY:
      return hex(g[G_KEYS[_a[0]]] as string);
    case G_STR:
      return new TextEncoder().encode(g[G_STRS[_a[0]]] as string);
    case G_NUM:
      return be64(g[G_NUMS[_a[0]]] as number);
    case G_CERT:
      return new TextEncoder().encode(g.certificate as string);
    case G_DESC:
      return new TextEncoder().encode(g.descriptor as string);
    case G_VOTE:
      return new TextEncoder().encode(g.vote as string);
    default:
      throw new Error(`unknown vector field ${what}`);
  }
}

await wacTestRun("packages/tor/test/wac/vote_test.wac", "vote", [ref]);
