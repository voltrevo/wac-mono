// Registers the wac-side microdescriptor tests.
//
// The oracle is `test/data/microdesc_vectors.json`, captured by `tools/capture-microdesc.py`, which
// puts each document through tor's own `microdescs_parse_from_string` and records **the digest tor
// computed**. That is the assertion that matters, and the reason is in the mutation table the same
// file carries: tor accepts a microdescriptor whose ntor key has been altered, whose `id` line has
// been removed, or whose trailing newline is missing. Only the digest changes.
//
// So a test that asked "does tor accept it?" would pass for a generator producing the wrong bytes,
// and the client that fetched them would report nothing worse than having no usable relays. The
// digest is the join between a consensus's `m` line and the document it names, and it is the only
// thing here that is load-bearing.
//
// The inputs are descriptors this repo generated and tor accepted — the same seam
// `routerdesc_wac.test.ts` uses, for the same reason: the fixture is committed rather than
// regenerated, so the suite does not need a built tor tree to be green.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

const M_COUNT = 0;
const M_DESCRIPTOR = 1; // a[0]=i: the router descriptor the microdescriptor is made from
const M_POLICY = 2; // a[0]=i: the port-summary policy for that case
const M_EXPECTED = 3; // a[0]=i: the microdescriptor tor accepted, byte for byte
const M_DIGEST = 4; // a[0]=i: the SHA-256 digest tor computed over it
const M_DIGEST_B64 = 5; // a[0]=i: that digest as tor's unpadded base64
const M_MUT_COUNT = 6;
const M_MUT_DIGEST_B64 = 7; // a[0]=i: the digest tor gave a *corrupted* microdescriptor

const v = JSON.parse(
  await Deno.readTextFile(new URL("data/microdesc_vectors.json", import.meta.url)),
) as {
  cases: {
    name: string;
    descriptor: string;
    policySummary: string;
    microdescriptor: string;
    digest256Base64: string;
    ntorOnionKey: string;
    ed25519Id: string;
  }[];
  mutations: { name: string; microdescriptor: string; accepted: boolean; digest256Base64: string }[];
};

if (v.cases.length < 2) {
  throw new Error(`expected several microdescriptor cases, found ${v.cases.length}`);
}
// Both policies must appear, because the `p` line is present for one and absent for the other, and
// "absent" is the case a generator gets wrong by writing `p reject 1-65535` where tor writes nothing.
if (!v.cases.some((c) => c.policySummary === "accept 1-65535")) {
  throw new Error("the vectors must include an exit policy, or the p line is never written");
}
if (!v.cases.some((c) => c.policySummary === "reject 1-65535")) {
  throw new Error("the vectors must include the default policy, or the omitted p line is untested");
}
if (v.mutations.length < 1) throw new Error("no mutations, so the digest check proves nothing");
// The mutations exist to show the digest discriminates. If tor gave a corrupted document the same
// digest as the good one, the assertion built on it would be vacuous — so it is checked here, at
// fixture-load time, rather than trusted.
for (const m of v.mutations) {
  if (m.digest256Base64 === v.cases[0].digest256Base64) {
    throw new Error(`mutation "${m.name}" kept the original digest, so the digest is not a check`);
  }
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const b64 = (s: string) =>
  Uint8Array.from(atob(s + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const be32 = (n: number) => {
  const out = new Uint8Array(4);
  for (let i = 3; i >= 0; i--) out[i] = (n >> (8 * (3 - i))) & 0xff;
  return out;
};

function ref(what: number, a: Uint8Array, _b: Uint8Array): Uint8Array {
  switch (what) {
    case M_COUNT:
      return be32(v.cases.length);
    case M_DESCRIPTOR:
      return utf8(v.cases[a[0]].descriptor);
    case M_POLICY:
      return utf8(v.cases[a[0]].policySummary);
    case M_EXPECTED:
      return utf8(v.cases[a[0]].microdescriptor);
    case M_DIGEST:
      return b64(v.cases[a[0]].digest256Base64);
    case M_DIGEST_B64:
      return utf8(v.cases[a[0]].digest256Base64);
    case M_MUT_COUNT:
      return be32(v.mutations.length);
    case M_MUT_DIGEST_B64:
      return utf8(v.mutations[a[0]].digest256Base64);
    default:
      throw new Error(`unknown vector field ${what}`);
  }
}

await wacTestRun("packages/tor/test/wac/microdesc_test.wac", "microdesc", [ref]);
