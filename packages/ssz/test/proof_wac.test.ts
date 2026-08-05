// Merkle-branch verification against Ethereum's own light-client proof vectors.
//
// Three proofs into one `BeaconState` per fork — the current sync committee, the next sync committee,
// and the finalized root. Exactly the three branches an Altair light client verifies.
//
// ## Why these are usable without a BeaconState descriptor
//
// The vectors give `leaf`, `leaf_index` and `branch`, and the object they were taken from. They do
// *not* give the state root, so checking them looks like it needs `hash_tree_root(BeaconState)` —
// which this package deliberately does not implement, because a light client never merkleizes a state.
// It verifies branches *into* a root it is handed.
//
// The way through is that all three cases in a fork come from the **same** object, so three different
// gindexes at three different depths must fold to one root. That is a real check with no circularity:
// a wrong side-bit rule gives three different answers, because the three paths differ.
//
// The fold is done here with the **host's** SHA-256 via Web Crypto, and wac only ever *verifies*.
// Folding with wac and then checking with wac would be a symmetric oracle.

import { wacBind } from "../../../harness/wacBind.ts";
import { fixtureJson, type FixtureManifest } from "../../../harness/fixtures.ts";

const manifest = JSON.parse(
  await Deno.readTextFile(new URL("fixtures.json", import.meta.url)),
) as FixtureManifest;

const mod = await wacBind("packages/ssz/test/wac/probe.wac") as unknown as {
  sszValidBranch(
    leaf: Uint8Array, branch: Uint8Array, depth: number, index: number, root: Uint8Array,
  ): boolean;
  sszValidNormalizedBranch(
    leaf: Uint8Array, branch: Uint8Array, gindex: number, root: Uint8Array,
  ): boolean;
  sszFloorLog2(x: number): number;
  sszSubtreeIndex(g: number): number;
};

type Proof = { fork: string; case: string; leaf: string; gindex: number; branch: string[] };
const fixture = await fixtureJson<{ cases: Proof[] }>("ssz", "light_client_proofs", manifest);

const bytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const cat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};
const sha = async (b: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", b as unknown as BufferSource));

/** Fold a branch up to the root, host-side, the way the spec defines it. */
async function fold(p: Proof): Promise<Uint8Array> {
  let node = bytes(p.leaf);
  let idx = p.gindex;
  for (const sib of p.branch) {
    const s = bytes(sib);
    node = await sha(idx & 1 ? cat(s, node) : cat(node, s));
    idx >>= 1;
  }
  return node;
}

const flat = (p: Proof) => bytes(p.branch.join(""));
const byFork = new Map<string, Proof[]>();
for (const c of fixture.cases) {
  if (!byFork.has(c.fork)) byFork.set(c.fork, []);
  byFork.get(c.fork)!.push(c);
}

Deno.test("three proofs into one state fold to one root, per fork", async () => {
  if (byFork.size !== 3) throw new Error(`expected 3 forks, got ${[...byFork.keys()]}`);
  for (const [fork, proofs] of byFork) {
    if (proofs.length !== 3) throw new Error(`${fork}: ${proofs.length} proofs, expected 3`);
    const roots = new Set<string>();
    for (const p of proofs) roots.add(hex(await fold(p)));
    if (roots.size !== 1) {
      throw new Error(
        `${fork}: three proofs into the same object folded to ${roots.size} different roots — ` +
          `the side-bit rule is wrong for at least one path`,
      );
    }
  }
});

Deno.test("wac verifies every real branch, and rejects every perturbation of one", async () => {
  let checked = 0;
  for (const [fork, proofs] of byFork) {
    for (const p of proofs) {
      const root = await fold(p);
      const branch = flat(p);
      const depth = p.branch.length;
      const index = p.gindex - 2 ** depth;

      if (mod.sszFloorLog2(p.gindex) !== depth) {
        throw new Error(`${fork}/${p.case}: floorLog2(${p.gindex}) disagrees with a ${depth}-node branch`);
      }
      if (mod.sszSubtreeIndex(p.gindex) !== index) {
        throw new Error(`${fork}/${p.case}: subtreeIndex(${p.gindex}) is not ${index}`);
      }
      if (!mod.sszValidBranch(bytes(p.leaf), branch, depth, index, root)) {
        throw new Error(`${fork}/${p.case}: a real Ethereum branch was rejected`);
      }
      if (!mod.sszValidNormalizedBranch(bytes(p.leaf), branch, p.gindex, root)) {
        throw new Error(`${fork}/${p.case}: rejected by the normalized check`);
      }
      // A wrong gindex must fail, because the index is what picks the side at each level — this is the
      // check a fixed hashing order would pass.
      //
      // Not the *sibling* index, though, and the reason is a property of these vectors rather than of
      // the code. In this state `current_sync_committee` equals `next_sync_committee`, so gindexes 54
      // and 55 have the **same leaf**, and `branch[0]` is that leaf again. Then `H(leaf ‖ sib)` and
      // `H(sib ‖ node)` are the same bytes, and both orderings verify — correctly. My first version
      // asserted the sibling must fail and this vector proved it wrong.
      //
      // The degeneracy is not confined to the sync committees either: this state is genesis-like, so
      // the finalized root is all zeros **and so is its sibling**. I guessed otherwise and the vector
      // said no. Perturbing the index is therefore weak on this data in general, and the properly
      // adversarial version of that check lives in `merkle_wac.test.ts`, over trees built here with
      // distinct leaves by construction. What these vectors are for is the positive direction —
      // real Ethereum branches, at real gindexes, verifying — and the fold agreeing three ways.
      //
      // Flipping bit 1 moves the path a level up, which is not symmetric here, so it still bites.
      const wrongPath = p.gindex ^ 2;
      if (mod.sszValidNormalizedBranch(bytes(p.leaf), branch, wrongPath, root)) {
        throw new Error(`${fork}/${p.case}: verified at gindex ${wrongPath} as well as ${p.gindex}`);
      }
      const tampered = branch.slice();
      tampered[tampered.length - 1] ^= 1; //     the node nearest the root
      if (mod.sszValidNormalizedBranch(bytes(p.leaf), tampered, p.gindex, root)) {
        throw new Error(`${fork}/${p.case}: a tampered branch verified`);
      }
      checked++;
    }
  }
  if (checked !== 9) throw new Error(`checked ${checked} proofs, expected 9`);
});

Deno.test("the generalized indices are fork-dependent, which is why normalized branches exist", async () => {
  // Altair and Deneb put the sync committees at 54/55 and the finalized root at 105. **Electra moved
  // them** to 86/87 and 169, one level deeper. So the same logical proof is a 5-node branch under one
  // fork and a 6-node branch under another.
  //
  // That is the reason `is_valid_normalized_merkle_branch` exists rather than being tidiness: a proof
  // generated for the shallower layout appears in the deeper one with leading nodes that must be
  // *zero*, and accepting non-zero surplus there would let a prover hang an unrelated subtree below
  // the field being proved. `merkle_wac.test.ts` covers that rule; this records why it is needed.
  //
  // `src/beacon.wac` declares the Altair depths, and that is correct for the fork it names — but a
  // light client extended past Deneb has to make them fork-dependent, and this test is where that
  // will fail first.
  const want: Record<string, [number, number, number]> = {
    altair: [54, 55, 105],
    deneb: [54, 55, 105],
    electra: [86, 87, 169],
  };
  const order = [
    "current_sync_committee_merkle_proof",
    "next_sync_committee_merkle_proof",
    "finality_root_merkle_proof",
  ];
  for (const [fork, expected] of Object.entries(want)) {
    const proofs = byFork.get(fork);
    if (proofs === undefined) throw new Error(`no proofs for ${fork}`);
    order.forEach((name, i) => {
      const p = proofs.find((x) => x.case === name);
      if (p === undefined) throw new Error(`${fork}: no ${name}`);
      if (p.gindex !== expected[i]) {
        throw new Error(`${fork}/${name}: gindex ${p.gindex}, expected ${expected[i]}`);
      }
    });
  }
  // And the depths follow: floorlog2 of the gindex, which is what the branch length must be.
  for (const c of fixture.cases) {
    if (c.branch.length !== mod.sszFloorLog2(c.gindex)) {
      throw new Error(`${c.fork}/${c.case}: ${c.branch.length} nodes for gindex ${c.gindex}`);
    }
  }
});
