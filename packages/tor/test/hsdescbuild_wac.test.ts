// Registers the wac-side descriptor-build tests.
//
// The variants come from `data/hspublish.json`, where `capture-hspub.py` put each of them to *both*
// oracles: tor's HSDir cache filed it, and tor's client decoder decrypted it and counted the
// introduction points. The committed fixture is one service with one introduction point in one time
// period, so a builder that ignored everything past the first introduction point would reproduce it
// exactly — the variants are the only thing that can show otherwise.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

const B_VARIANT_COUNT = 0;
const B_VARIANT_INTROS = 1;
const B_VARIANT_FOUND = 2;
const B_VARIANT_LENS = 3;

const v = JSON.parse(
  await Deno.readTextFile(new URL("data/hspublish.json", import.meta.url)),
) as {
  source: string;
  variants: {
    name: string;
    introPoints: number;
    blindedKey: string;
    storedByHsdir: boolean;
    decodedIntroPoints: number;
    accepted: boolean;
  }[];
};

const generated = JSON.parse(
  await Deno.readTextFile(new URL("data/hsdesc_generated.json", import.meta.url)),
) as { variants: { name: string; innerPlainLen: number; middleLen: number }[] };

if (!v.source.includes("hs_cache_store_as_dir")) {
  throw new Error(`the verdicts must be tor's — source is ${v.source}`);
}
if (v.variants.length < 3) throw new Error("too few variants to show the build generalises");
if (v.variants.length !== generated.variants.length) {
  throw new Error("the vector and the verdicts disagree about how many variants there are");
}
for (const [i, x] of v.variants.entries()) {
  if (!x.storedByHsdir) throw new Error(`an HSDir would not file the variant ${x.name}`);
  if (!x.accepted) throw new Error(`a client would not decode the variant ${x.name}`);
  if (x.name !== generated.variants[i].name) {
    throw new Error(`variant ${i} is ${x.name} in one file and ${generated.variants[i].name} in the other`);
  }
}
// At least one variant must have more than one introduction point, and at least one must be a
// different time period — otherwise every variant is the fixture again under another name.
if (!v.variants.some((x) => x.introPoints > 1)) {
  throw new Error("no variant has more than one introduction point");
}
if (new Set(v.variants.map((x) => x.blindedKey)).size < 2) {
  throw new Error("every variant is filed under the same name, so the period is not reaching it");
}

const i32be = (...ns: number[]) =>
  Uint8Array.from(ns.flatMap((n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]));

function ref(what: number, a: Uint8Array, _b: Uint8Array): Uint8Array {
  switch (what) {
    case B_VARIANT_COUNT:
      return new Uint8Array([v.variants.length]);
    case B_VARIANT_INTROS:
      return new Uint8Array([v.variants[a[0]].introPoints]);
    case B_VARIANT_FOUND:
      return new Uint8Array([v.variants[a[0]].decodedIntroPoints]);
    case B_VARIANT_LENS:
      return i32be(generated.variants[a[0]].innerPlainLen, generated.variants[a[0]].middleLen);
    default:
      throw new Error(`unknown vector field ${what}`);
  }
}

await wacTestRun("packages/tor/test/wac/hsdescbuild_test.wac", "hsdescbuild", [ref]);
