// Registers the wac-side directory-serving tests.
//
// The documents are the ones this repo generates and C tor has judged: the consensus from
// `data/consensus_generated.json`, the certificate from `data/authcert_generated.json`, the descriptor
// from `data/routerdesc_generated.json`. So a route test is not only about paths — what it hands back is
// a document tor accepted.
//
// The request targets are the ones a bootstrapping tor actually builds, taken from `dirclient.c`:
//
//     /tor/status-vote/current/consensus[-<flavour>]/<fp>+<fp>+....z
//
// with the `.z` asking for compression and the fingerprints naming the authorities the client trusts.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

const D_CONSENSUS = 0;
const D_CERT = 1;
const D_DESCRIPTOR = 2;
const D_DESC_DIGEST = 3;
const D_FINGERPRINT = 4;

const cons = JSON.parse(
  await Deno.readTextFile(new URL("data/consensus_generated.json", import.meta.url)),
) as Record<string, string>;
const cert = JSON.parse(
  await Deno.readTextFile(new URL("data/authcert_generated.json", import.meta.url)),
) as Record<string, string>;
const desc = JSON.parse(
  await Deno.readTextFile(new URL("data/routerdesc_generated.json", import.meta.url)),
) as Record<string, string>;

const enc = (s: string) => new TextEncoder().encode(s);
const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

/**
 * The descriptor digest an `r` line carries: SHA-1 over the span the RSA signature covers, which ends
 * after `router-signature\n` and not at the end of the document. Computed here with the host's own
 * SHA-1 so the wac side is not asked to trust its own span twice.
 */
const descriptorDigest = await (async () => {
  const text = desc.descriptor;
  const span = text.indexOf("router-signature\n") + "router-signature\n".length;
  const digest = await crypto.subtle.digest("SHA-1", enc(text.slice(0, span)));
  return new Uint8Array(digest);
})();

function ref(what: number, _a: Uint8Array, _b: Uint8Array): Uint8Array {
  switch (what) {
    case D_CONSENSUS:
      return enc(cons.consensus);
    case D_CERT:
      return enc(cert.certificate);
    case D_DESCRIPTOR:
      return enc(desc.descriptor);
    case D_DESC_DIGEST:
      return descriptorDigest;
    case D_FINGERPRINT:
      return hex(cons.identityDigest);
    default:
      throw new Error(`unknown vector field ${what}`);
  }
}

await wacTestRun("packages/tor/test/wac/dirserve_test.wac", "dirserve", [ref]);
