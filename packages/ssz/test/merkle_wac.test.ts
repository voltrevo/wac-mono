// Merkleization against Ethereum's `ssz_generic` vectors.
//
// 754 of the 1,217 cases need no schema, because the case *name* carries the type:
// `uint_128_max`, `bitvec_513_random`, `bitlist_512_lengthy_3`, `vec_uint256_5_zero`. Those are driven
// here. The remaining 463 are `containers`, handled in `container_wac.test.ts`.
//
// The interesting parameter in every case is the **limit**, not the data. A `Bitlist[512]` holding
// fifteen bits merkleizes over a tree sized for 512 bits, so an implementation that pads to the data
// it was given produces a root that is wrong for every short value and right for every full one. The
// `_zero` and `_lengthy` cases at each width are what separate those two implementations, which is why
// the counts below are asserted per type rather than in total.

import { wacBind } from "../../../harness/wacBind.ts";
import { fixtureJson, type FixtureManifest } from "../../../harness/fixtures.ts";

const manifest = JSON.parse(
  await Deno.readTextFile(new URL("fixtures.json", import.meta.url)),
) as FixtureManifest;


const mod = await wacBind("packages/ssz/test/wac/probe.wac") as unknown as {
  sszRootBasic(s: Uint8Array): Uint8Array;
  sszRootBasicVector(s: Uint8Array, chunkLimit: number): Uint8Array;
  sszRootBitvector(s: Uint8Array, n: number): Uint8Array;
  sszRootBitlist(s: Uint8Array, limit: number): Uint8Array;
  sszBitlistLength(s: Uint8Array): number;
  sszZeroHash(d: number): Uint8Array;
  sszMerkleize(data: Uint8Array, limit: number): Uint8Array;
  sszMixInLength(root: Uint8Array, n: number): Uint8Array;
  sszValidBranch(
    leaf: Uint8Array, branch: Uint8Array, depth: number, index: number, root: Uint8Array,
  ): boolean;
  sszValidNormalizedBranch(
    leaf: Uint8Array, branch: Uint8Array, gindex: number, root: Uint8Array,
  ): boolean;
  sszHashPair(a: Uint8Array, b: Uint8Array): Uint8Array;
  sszFloorLog2(x: number): number;
  sszSubtreeIndex(g: number): number;
};

type Case = { type: string; case: string; ssz: string; root: string };
const fixture = await fixtureJson<{ cases: Case[] }>("ssz", "ssz_generic_valid", manifest);

const bytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

/** Bytes per element, for the basic types `basic_vector` is parameterised over. */
const ELEM: Record<string, number> = {
  bool: 1, uint8: 1, uint16: 2, uint32: 4, uint64: 8, uint128: 16, uint256: 32,
};

/** The root this case's type implies, or null when the name is not one this test drives. */
function rootFor(c: Case): Uint8Array | null {
  const ssz = bytes(c.ssz);
  if (c.type === "uints" || c.type === "boolean") return mod.sszRootBasic(ssz);
  let m = /^bitvec_(\d+)_/.exec(c.case);
  if (m) return mod.sszRootBitvector(ssz, Number(m[1]));
  m = /^bitlist_(\d+)_/.exec(c.case);
  if (m) return mod.sszRootBitlist(ssz, Number(m[1]));
  m = /^vec_([a-z0-9]+)_(\d+)_/.exec(c.case);
  if (m) {
    const size = ELEM[m[1]];
    if (size === undefined) return null;
    // ceil(N * sizeof(T) / 32) — the chunks a *full* vector of this type occupies.
    return mod.sszRootBasicVector(ssz, Math.ceil((Number(m[2]) * size) / 32));
  }
  return null;
}

Deno.test("every schema-free ssz_generic case merkleizes to Ethereum's root", () => {
  const perType: Record<string, number> = {};
  const failures: string[] = [];
  for (const c of fixture.cases) {
    const got = rootFor(c);
    if (got === null) continue;
    perType[c.type] = (perType[c.type] ?? 0) + 1;
    if (hex(got) !== c.root) {
      if (failures.length < 8) {
        failures.push(`${c.type}/${c.case}\n    got  ${hex(got)}\n    want ${c.root}`);
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length}+ root mismatches:\n  ${failures.join("\n  ")}`);
  }
  // Per type, so a regex that stops matching shows up as a gap rather than as a pass.
  const want = { uints: 48, boolean: 2, bitvector: 54, bitlist: 450, basic_vector: 200 };
  for (const [t, n] of Object.entries(want)) {
    if (perType[t] !== n) throw new Error(`drove ${perType[t] ?? 0} ${t} cases, expected ${n}`);
  }
});

Deno.test("the limit is what fixes the tree, not the data's length", () => {
  // The property that separates a correct merkleizer from one that pads to its input. Two chunks of
  // real data under limits of 2, 4 and 8 must give three different roots; an implementation ignoring
  // the limit gives one.
  const data = new Uint8Array(64);
  data[0] = 1;
  data[32] = 2;
  const roots = [2, 4, 8].map((l) => hex(mod.sszMerkleize(data, l)));
  if (new Set(roots).size !== 3) {
    throw new Error(`limits 2/4/8 gave ${new Set(roots).size} distinct root(s): the limit is ignored`);
  }
  // And a limit below the data must not truncate it — the tree grows to hold what it was given.
  if (hex(mod.sszMerkleize(data, 1)) !== hex(mod.sszMerkleize(data, 2))) {
    throw new Error("a limit smaller than the data changed the root");
  }
});

Deno.test("zeroHash is the padded subtree it stands in for", () => {
  // The optimisation and the thing it replaces must agree, or every short value is wrong.
  let expect: Uint8Array<ArrayBufferLike> = new Uint8Array(32);
  for (let d = 0; d < 6; d++) {
    if (hex(mod.sszZeroHash(d)) !== hex(expect)) {
      throw new Error(`zeroHash(${d}) is not the zero subtree of that depth`);
    }
    expect = mod.sszHashPair(expect, expect);
  }
  // An empty value under a limit is exactly the zero subtree.
  if (hex(mod.sszMerkleize(new Uint8Array(0), 8)) !== hex(mod.sszZeroHash(3))) {
    throw new Error("merkleizing nothing under a limit of 8 is not zeroHash(3)");
  }
});

Deno.test("a bitlist's delimiter is measured, not merkleized", () => {
  // `Bitlist` length comes from the highest set bit of the last byte, and that bit is not data.
  // Eight zero bits are `00 01`: a zero byte, then the delimiter alone in the next.
  const cases: [number[], number][] = [
    [[0x01], 0], [[0x02], 1], [[0x03], 1], [[0xff], 7], [[0x00, 0x01], 8], [[0xff, 0x01], 8],
  ];
  for (const [byteList, bits] of cases) {
    const got = mod.sszBitlistLength(new Uint8Array(byteList));
    if (got !== bits) {
      throw new Error(`bitlistLength([${byteList.map((b) => b.toString(16))}]) = ${got}, want ${bits}`);
    }
  }
  // No delimiter at all is malformed, not empty.
  if (mod.sszBitlistLength(new Uint8Array([0x00])) !== -1) throw new Error("a zero final byte was accepted");
  if (mod.sszBitlistLength(new Uint8Array(0)) !== -1) throw new Error("an empty bitlist was accepted");
  // Over the limit is a refusal, which the probe reports as an empty root.
  if (mod.sszRootBitlist(new Uint8Array([0xff]), 3).length !== 0) {
    throw new Error("seven bits were accepted into a Bitlist[3]");
  }
});

// ── Merkle branches ───────────────────────────────────────────────────────────
//
// `ssz_generic` has no branch vectors, so the tree here is built with the **host's** SHA-256 via Web
// Crypto. That matters: verifying wac's branch check against a tree built by wac's own merkleizer
// would be a symmetric oracle — both halves wrong together would still agree. The host's digest
// shares no code with `packages/crypto`.

const sha = async (b: Uint8Array<ArrayBufferLike>): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", b as unknown as BufferSource));
const cat = (a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

/** An 8-leaf tree from distinct leaves, returning every level bottom-up. */
async function tree(leaves: Uint8Array<ArrayBufferLike>[]): Promise<Uint8Array<ArrayBufferLike>[][]> {
  const levels: Uint8Array<ArrayBufferLike>[][] = [leaves];
  let level: Uint8Array<ArrayBufferLike>[] = leaves;
  while (level.length > 1) {
    const next: Uint8Array<ArrayBufferLike>[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(await sha(cat(level[i], level[i + 1])));
    levels.push(next);
    level = next;
  }
  return levels;
}

/** The sibling at each level on the path to `index`, bottom-up — which is what a branch is. */
function branchFor(levels: Uint8Array<ArrayBufferLike>[][], index: number): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array<ArrayBufferLike>[] = [];
  let i = index;
  for (let d = 0; d < levels.length - 1; d++) {
    parts.push(levels[d][i ^ 1]);
    i >>= 1;
  }
  return parts.reduce<Uint8Array<ArrayBuffer>>(cat, new Uint8Array(0));
}

Deno.test("isValidMerkleBranch accepts every position and rejects perturbations", async () => {
  const leaves = Array.from({ length: 8 }, (_, i) => {
    const l = new Uint8Array(32);
    l[0] = i + 1;
    return l;
  });
  const levels = await tree(leaves);
  const root = levels[levels.length - 1][0];

  for (let i = 0; i < 8; i++) {
    const branch = branchFor(levels, i);
    if (!mod.sszValidBranch(leaves[i], branch, 3, i, root)) {
      throw new Error(`a correct branch for leaf ${i} was rejected`);
    }
    // The index is what picks the side at each level, so a wrong one must fail — this is the check
    // that would pass if the implementation hashed in a fixed order.
    const wrong = i ^ 1;
    if (mod.sszValidBranch(leaves[i], branch, 3, wrong, root)) {
      throw new Error(`leaf ${i}'s branch verified at index ${wrong}: the side bits are ignored`);
    }
    // A flipped byte anywhere in the branch must fail.
    const tampered = branch.slice();
    tampered[0] ^= 1;
    if (mod.sszValidBranch(leaves[i], tampered, 3, i, root)) {
      throw new Error(`a tampered branch verified for leaf ${i}`);
    }
  }
  // A branch of the wrong length is a malformed proof, not a shorter one.
  if (mod.sszValidBranch(leaves[0], branchFor(levels, 0).slice(0, 64), 3, 0, root)) {
    throw new Error("a two-node branch verified at depth 3");
  }
});

Deno.test("the normalized branch check requires the surplus nodes to be zero", async () => {
  const leaves = Array.from({ length: 8 }, (_, i) => {
    const l = new Uint8Array(32);
    l[31] = i + 1;
    return l;
  });
  const levels = await tree(leaves);
  const root = levels[levels.length - 1][0];
  const index = 5;
  const gindex = 8 + index;                       // depth 3, so floorlog2 = 3 and subtree index = 5
  if (mod.sszFloorLog2(gindex) !== 3) throw new Error("floorLog2 disagrees about the depth");
  if (mod.sszSubtreeIndex(gindex) !== index) throw new Error("subtreeIndex disagrees");

  const branch = branchFor(levels, index);
  if (!mod.sszValidNormalizedBranch(leaves[index], branch, gindex, root)) {
    throw new Error("an exact-length normalized branch was rejected");
  }
  // A branch longer than the gindex needs is legitimate when the surplus is zero — that is how a
  // fork moves a field deeper without changing the proof's wire format.
  const zeroPadded = cat(new Uint8Array(64), branch);
  if (!mod.sszValidNormalizedBranch(leaves[index], zeroPadded, gindex, root)) {
    throw new Error("a zero-padded normalized branch was rejected");
  }
  // Non-zero surplus must be refused, not trimmed. Accepting it would let a prover hang an unrelated
  // subtree below the field being proved, which is why the spec returns false here.
  const junk = new Uint8Array(64);
  junk[7] = 1;
  if (mod.sszValidNormalizedBranch(leaves[index], cat(junk, branch), gindex, root)) {
    throw new Error("a normalized branch with non-zero surplus nodes was accepted");
  }
  // Too short to address the depth is a refusal.
  if (mod.sszValidNormalizedBranch(leaves[index], branch.slice(0, 64), gindex, root)) {
    throw new Error("a branch shorter than the gindex's depth was accepted");
  }
});
