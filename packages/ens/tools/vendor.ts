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

import { concat, dnsEncode, ensNormalize, id, keccak256, namehash, toBeHex, zeroPadValue }
  from "npm:ethers@6";

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
  // Two names whose owner slots end in `ff` and `ffff`, so the increment to the resolver slot carries once
  // and twice. Found by search — see `nameWithCarry`.
  nameWithCarry(1),
  nameWithCarry(2),
];

/**
 * A name whose owner slot ends in `ff…`, so the corpus exercises the carry.
 *
 * "The next slot" is an increment across a 256-bit number, and an implementation that only touches the last
 * byte is right 255 times in 256. Ground out here rather than asserted, because which name has that property
 * depends on keccak256 and is not something to guess: the search is a few thousand hashes and runs once.
 */
function nameWithCarry(zeros: number): string {
  const want = "ff".repeat(zeros);
  for (let i = 0; i < 200_000; i++) {
    const name = `carry-${i}.eth`;
    const owner = keccak256(concat([namehash(name), zeroPadValue(toBeHex(0), 32)]));
    if (owner.endsWith(want)) return name;
  }
  throw new Error(`no name found whose owner slot ends in ${want}`);
}

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
  names: NAMES.map((name) => {
    const node = namehash(name);
    // Solidity's mapping rule, from ethers rather than from this repo: `records` is the registry's first
    // declared variable, so `records[node]` starts at `keccak256(node ++ 0)` and its fields follow.
    const owner = keccak256(concat([node, zeroPadValue(toBeHex(0), 32)]));
    const next = (slot: string, by: bigint) =>
      "0x" + ((BigInt(slot) + by) % (1n << 256n)).toString(16).padStart(64, "0");
    return {
      name,
      namehash: node.slice(2),
      dns: dnsEncode(name).slice(2),
      ownerSlot: owner.slice(2),
      resolverSlot: next(owner, 1n).slice(2),
      ttlSlot: next(owner, 2n).slice(2),
    };
  }),
  selectors: SIGNATURES.map((signature) => ({ signature, selector: id(signature).slice(2, 10) })),
}, null, 2));
