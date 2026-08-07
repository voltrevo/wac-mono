// A name in, an address out, through four packages and a proof.
//
// Everything else in this repo tests one package against an oracle. This is the first that tests the
// *composition*, which is where the interesting failures live: each step can be right on its own and still
// be wired to the next one wrongly, and the result is not an error — it is a well-formed proof about the
// wrong storage slot, which reads as "this name has no owner".
//
//     "wac.eth"  --namehash-->  node  --keccak(node ++ 0)-->  slot
//                --state trie-->  the registry's account  --storage trie-->  the owner
//
// `packages/ens` does the first two, `packages/mpt` the second two, `packages/rlp` and `packages/crypto`
// underneath both. The fixture is `eth_getProof` from **anvil**, and the two derivations are cross-checked
// against **cast** — a separate implementation of both, which is what makes this more than the repo
// agreeing with itself:
//
//   - a node computed left-to-right instead of right-to-left,
//   - a mapping slot hashed as `slot ++ key` instead of `key ++ slot`,
//
// both produce a valid proof about a real slot that happens to be the wrong one. Neither is a parse error
// and neither shows up in a single-package test.

import { wacBind } from "../../../harness/wacBind.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

const probe = await wacBind("packages/ens/test/wac/registry_probe.wac") as Record<string, unknown>;
const resolveOwner = probe.resolveOwner as (r: Uint8Array, g: Uint8Array, n: Uint8Array, a: Uint8Array, s: Uint8Array) => Uint8Array;
const resolveResolver = probe.resolveResolver as (r: Uint8Array, g: Uint8Array, n: Uint8Array, a: Uint8Array, s: Uint8Array) => Uint8Array;
const nodeOf = probe.nodeOf as (n: Uint8Array) => Uint8Array;
const ownerSlotOf = probe.ownerSlotOf as (n: Uint8Array) => Uint8Array;
const resolverSlotOf = probe.resolverSlotOf as (n: Uint8Array) => Uint8Array;

const hex = (b: Uint8Array) => "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.replace(/^0x/, "").match(/../g)?.map((h) => parseInt(h, 16)) ?? []);
const enc = new TextEncoder();
const dec = new TextDecoder();

function packNodes(nodes: string[]): Uint8Array {
  const bytes = nodes.map(unhex);
  const out = new Uint8Array(bytes.reduce((n, x) => n + 4 + x.length, 0));
  let at = 0;
  for (const n of bytes) {
    out[at] = n.length & 0xff;
    out[at + 1] = (n.length >> 8) & 0xff;
    out[at + 2] = (n.length >> 16) & 0xff;
    out[at + 3] = (n.length >> 24) & 0xff;
    out.set(n, at + 4);
    at += 4 + n.length;
  }
  return out;
}

type SlotProof = { key: string; value: string; proof: string[] };
type Case = {
  name: string;
  node: string;
  ownerSlot: string;
  resolverSlot: string;
  owned: boolean;
  ownerProof: SlotProof;
  resolverProof: SlotProof;
};
const vector = JSON.parse(
  await Deno.readTextFile(new URL("./vendor/registry.json", import.meta.url)),
) as {
  registry: string;
  owner: string;
  resolver: string;
  stateRoot: string;
  accountProof: string[];
  cases: Case[];
};

if (vector.cases.length < 3) throw new Error(`only ${vector.cases.length} cases — is the fixture intact?`);

const stateRoot = unhex(vector.stateRoot);
const registry = unhex(vector.registry);
const account = packNodes(vector.accountProof);

type Answer = { ok: boolean; present: boolean; address: string; error: string };
function decode(out: Uint8Array): Answer {
  const present = out[1] === 1;
  return {
    ok: out[0] === 1,
    present,
    address: present ? hex(out.subarray(2, 22)) : "",
    error: dec.decode(out.subarray(present ? 22 : 2)),
  };
}

Deno.test("the two derivations agree with cast, which computed them independently", () => {
  // Before the composition means anything, the two steps that turn a name into a place have to be right.
  // `cast namehash` and `cast index bytes32 <node> 0` are Foundry's own, in Rust.
  for (const c of vector.cases) {
    assertEquals(hex(nodeOf(enc.encode(c.name))), c.node, `${c.name}: namehash`);
    assertEquals(hex(ownerSlotOf(enc.encode(c.name))), c.ownerSlot, `${c.name}: owner slot`);
    // The resolver is the struct's second field, which is a 256-bit increment rather than a `+ 1` on
    // something register-sized. The fixture carries it as its own value for that reason.
    assertEquals(hex(resolverSlotOf(enc.encode(c.name))), c.resolverSlot, `${c.name}: resolver slot`);
  }
});

Deno.test("a name resolves to its owner, proved against the state root", () => {
  for (const c of vector.cases.filter((x) => x.owned)) {
    const got = decode(resolveOwner(stateRoot, registry, enc.encode(c.name), account,
      packNodes(c.ownerProof.proof)));
    assertEquals(got.ok, true, `${c.name}: ${got.error}`);
    assertEquals(got.present, true, `${c.name} should have an owner`);
    assertEquals(got.address, vector.owner.toLowerCase(), c.name);
  }
});

Deno.test("and to its resolver, which is the slot above", () => {
  for (const c of vector.cases.filter((x) => x.owned)) {
    const got = decode(resolveResolver(stateRoot, registry, enc.encode(c.name), account,
      packNodes(c.resolverProof.proof)));
    assertEquals(got.ok, true, `${c.name}: ${got.error}`);
    assertEquals(got.address, vector.resolver.toLowerCase(), c.name);
  }
});

Deno.test("a name nobody owns proves absent, which is an answer and not a failure", () => {
  const c = vector.cases.find((x) => !x.owned)!;
  const got = decode(resolveOwner(stateRoot, registry, enc.encode(c.name), account,
    packNodes(c.ownerProof.proof)));
  assertEquals(got.ok, true, `absence should verify — ${got.error}`);
  assertEquals(got.present, false, "nothing owns it");
  assertEquals(got.error, "", "and there is nothing to report");
});

Deno.test("the composition refuses what a lying provider would send", () => {
  const c = vector.cases.find((x) => x.owned)!;
  const other = vector.cases.find((x) => x.owned && x.name !== c.name)!;
  const bad: [string, Uint8Array, Uint8Array][] = [
    // Another name's storage proof, valid in itself, against this name's slot.
    ["somebody else's slot proof", account, packNodes(other.ownerProof.proof)],
    // The resolver slot's proof offered as the owner's.
    ["the slot above", account, packNodes(c.resolverProof.proof)],
    // An empty storage proof against a storage root that is not the empty trie's.
    ["no storage proof at all", account, new Uint8Array(0)],
  ];
  for (const [what, acc, store] of bad) {
    const got = decode(resolveOwner(stateRoot, registry, enc.encode(c.name), acc, store));
    assertEquals(got.ok && got.present, false, `${what}: answered ${got.address}`);
  }
  // And a state root that is not the one these proofs were taken against.
  const wrongRoot = unhex(vector.stateRoot);
  wrongRoot[31] ^= 1;
  const got = decode(resolveOwner(wrongRoot, registry, enc.encode(c.name), account,
    packNodes(c.ownerProof.proof)));
  assertEquals(got.ok, false, `a different state root answered ${got.address}`);
});
