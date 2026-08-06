// Registers the wac-side publication tests.
//
// The oracle is `test/data/hspublish.json`, from tor's own HSDir cache — `hs_cache_store_as_dir` and
// `hs_cache_lookup_as_dir`, via `tools/capture-hspub.py`.
//
// **What only a directory can tell us.** `hsdesc_wac.test.ts` shows a client can decrypt what we
// generate. A directory never decrypts anything: it reads the plaintext layer, checks the
// signing-key certificate, and files the descriptor under the blinded key found *inside* that
// certificate. The publish URL carries no key, so the uploader has no say in the name. A service
// whose blinded key and descriptor disagreed would be told "stored" and be unreachable — which is
// why `query` here is the name tor chose, and the wac test joins our fetch path to it.
//
// The guards below refuse a vector that cannot fail: every control must have been rejected, and the
// stored descriptor must be the one the generator produced.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

const P_BLINDED = 0;
const P_QUERY = 1;
const P_DESCRIPTOR = 2;

const v = JSON.parse(
  await Deno.readTextFile(new URL("data/hspublish.json", import.meta.url)),
) as {
  source: string;
  query: string;
  blindedKey: string;
  descriptorLength: number;
  stored: boolean;
  servedIdentical: boolean;
  controls: { name: string; result: { accepted: boolean; stored: boolean; lookup: string } }[];
};

const generated = JSON.parse(
  await Deno.readTextFile(new URL("data/hsdesc_generated.json", import.meta.url)),
) as { descriptor: string; blindPublic: string };

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const utf8 = (s: string) => new TextEncoder().encode(s);

if (!v.source.includes("hs_cache_store_as_dir")) {
  throw new Error(`the values must come from tor's HSDir cache — source is ${v.source}`);
}
if (!v.stored || !v.servedIdentical) {
  throw new Error("the vector records a descriptor an HSDir would not have served back");
}
if (v.blindedKey !== generated.blindPublic) {
  throw new Error("the vector was captured from a different descriptor than the one under test");
}
if (v.descriptorLength !== generated.descriptor.length) {
  throw new Error("the generated descriptor has changed since the vector was captured");
}
if (v.controls.length < 4) throw new Error("too few controls to show the probe can fail");
for (const c of v.controls) {
  if (c.result.accepted) throw new Error(`the control ${c.name} was accepted, so it proves nothing`);
}
// One control must be the discriminating one: a descriptor tor *did* store, looked up under the
// wrong name. Without it every control could be failing at the parse and the name would be untested.
if (!v.controls.some((c) => c.result.stored && c.result.lookup === "miss")) {
  throw new Error("no control distinguishes a bad descriptor from a bad name");
}

function ref(what: number, _a: Uint8Array, _b: Uint8Array): Uint8Array {
  switch (what) {
    case P_BLINDED:
      return hex(v.blindedKey);
    case P_QUERY:
      return utf8(v.query);
    case P_DESCRIPTOR:
      return utf8(generated.descriptor);
    default:
      throw new Error(`unknown vector field ${what}`);
  }
}

await wacTestRun("packages/tor/test/wac/hspublish_test.wac", "hspublish", [ref]);
