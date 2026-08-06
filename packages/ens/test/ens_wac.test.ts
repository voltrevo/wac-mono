// Registers the wac-side ENS tests and supplies the corpus `ethers` produced.
//
// Committed rather than fetched — a couple of kilobytes — so the suite needs no network. `tools/vendor.ts`
// regenerates it, and refuses any name that is not already ENSIP-15 normalised: this package hashes the
// labels it is given, so a name needing normalisation would be comparing against a hash of something else.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

type Corpus = {
  names: { name: string; namehash: string; dns: string }[];
  selectors: { signature: string; selector: string }[];
};

const corpus = JSON.parse(
  await Deno.readTextFile(new URL("./vendor/corpus.json", import.meta.url)),
) as Corpus;

if (corpus.names.length < 10 || corpus.selectors.length < 5) {
  throw new Error(
    `corpus has ${corpus.names.length} names and ${corpus.selectors.length} selectors — is it intact?`,
  );
}

const names = corpus.names.map((n) => `${n.name}|${n.namehash}|${n.dns}`);
const sigs = corpus.selectors.map((s) => `${s.signature}|${s.selector}`);

await wacTestRun("packages/ens/test/wac/ens_test.wac", "ens", [
  (i: number) => names[i],
  () => names.length,
  (i: number) => sigs[i],
  () => sigs.length,
]);
