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

const v = JSON.parse(
  await Deno.readTextFile(new URL("data/vote_vectors.json", import.meta.url)),
) as { votes: { signingKeyDer: string; signature: string; vote: string }[] };

if (v.votes.length < 1) throw new Error("no vote in the vector");
const vote = v.votes[0];

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

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
    default:
      throw new Error(`unknown vector field ${what}`);
  }
}

await wacTestRun("packages/tor/test/wac/vote_test.wac", "vote", [ref]);
