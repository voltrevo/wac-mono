// Generates `test/vendor/corpus.json` from `ethers`, the oracle for `packages/ens`.
//
//     deno run -A packages/ens/tools/vendor.ts > packages/ens/test/vendor/corpus.json
//
// Run by hand. The corpus is committed — a couple of kilobytes — so the tests need no network and cannot
// silently start passing because a download failed.
//
// **Every name here is checked to be already normalised**, and that check is the point rather than
// bookkeeping: `packages/ens` hashes the labels it is given and does *not* implement ENSIP-15
// normalisation, so a corpus containing `UPPER.eth` would be comparing against a hash of `upper.eth` and
// the difference would read as a bug in the hashing. The generator refuses such a name instead.

import { dnsEncode, ensNormalize, id, namehash } from "npm:ethers@6";

const NAMES = [
  "eth",
  "foo.eth",
  "a.b.c.eth",
  "vitalik.eth",
  "resolver.eth",
  "long-label-with-hyphens.eth",
  "0123456789.eth",
  "x.y.z.a.b.c.d.e.f.eth",
  "café.eth",
  "test",
  "a",
  "sub.domain.test",
];

const SIGNATURES = [
  "resolver(bytes32)",
  "addr(bytes32)",
  "addr(bytes32,uint256)",
  "text(bytes32,string)",
  "contenthash(bytes32)",
  "supportsInterface(bytes4)",
  "resolve(bytes,bytes)",
];

for (const n of NAMES) {
  const norm = ensNormalize(n);
  if (norm !== n) {
    throw new Error(
      `${JSON.stringify(n)} normalises to ${JSON.stringify(norm)}. This package hashes what it is given ` +
        `and does not implement ENSIP-15, so a corpus entry that needs normalising would test the wrong ` +
        `thing. Use the normalised form, or leave it out.`,
    );
  }
}

console.log(JSON.stringify({
  source: "npm:ethers@6 — namehash, dnsEncode, id",
  rebuild: "deno run -A packages/ens/tools/vendor.ts > packages/ens/test/vendor/corpus.json",
  note: "every name is already ENSIP-15 normalised; the generator refuses one that is not",
  names: NAMES.map((name) => ({
    name,
    namehash: namehash(name).slice(2),
    dns: dnsEncode(name).slice(2),
  })),
  selectors: SIGNATURES.map((signature) => ({ signature, selector: id(signature).slice(2, 10) })),
}, null, 2));
