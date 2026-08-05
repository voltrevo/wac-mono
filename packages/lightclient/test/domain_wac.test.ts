// The signing root, and a real sync-committee signature verified end to end.
//
// This is where `packages/bls` and `packages/ssz` meet. Verifying one update exercises, in order:
// SSZ field extraction from a `LightClientUpdate`, merkleization of the beacon header it names, the
// fork data root, the domain, the signing root, the sync-committee bit selection, and BLS
// `FastAggregateVerify` over the participating keys. A fault anywhere in that chain produces a
// signature that does not verify, so a pass is a strong statement about all of it.
//
// The data is Ethereum's own `light_client/sync` vectors, minimal config.

import { wacBind } from "../../../harness/wacBind.ts";
import { fixtureJson, type FixtureManifest } from "../../../harness/fixtures.ts";

const mod = await wacBind("packages/lightclient/test/wac/probe.wac") as unknown as {
  lcForkDigest(version: Uint8Array, gvr: Uint8Array): Uint8Array;
  lcAltairVersionMinimal(): Uint8Array;
  lcAltairVersionMainnet(): Uint8Array;
  lcDomain(version: Uint8Array, gvr: Uint8Array): Uint8Array;
  lcSigningRoot(headerRoot: Uint8Array, version: Uint8Array, gvr: Uint8Array): Uint8Array;
  lcSigningRootRaw(objectRoot: Uint8Array, domain: Uint8Array): Uint8Array;
  lcForkDataRoot(version: Uint8Array, gvr: Uint8Array): Uint8Array;
  lcField(which: number, data: Uint8Array, f: number): Uint8Array;
  lcFieldRoot(which: number, data: Uint8Array, f: number): Uint8Array;
  lcFastAggregateVerify(pubkeys: Uint8Array[], signingRoot: Uint8Array, sig: Uint8Array): boolean;
};

const manifest = JSON.parse(
  await Deno.readTextFile(new URL("../../ssz/test/fixtures.json", import.meta.url)),
) as FixtureManifest;
type Step = { kind: string; update?: string; checks?: { optimistic_header?: { beacon_root: string } } };
type Case = {
  case: string; meta: Record<string, string>; steps: Step[];
  bootstrap: string; updates: Record<string, string>;
};
const fixture = await fixtureJson<{ cases: Case[] }>(
  "ssz", "light_client_sync_altair_minimal", manifest,
);

const un = (h: string) => Uint8Array.from(h.replace(/^0x/, "").match(/../g) ?? [], (x) => parseInt(x, 16));
const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

// Container selectors, matching `tyOf` in the probe.
const UPDATE = 0, BOOTSTRAP = 1, HEADER = 2, COMMITTEE = 3, AGGREGATE = 4;
// Field indices, from `src/beacon.wac`'s field lists.
const UPDATE_ATTESTED = 0, UPDATE_NEXT_COMMITTEE = 1, UPDATE_SYNC_AGGREGATE = 5;
const BOOTSTRAP_CURRENT_COMMITTEE = 1, COMMITTEE_PUBKEYS = 0;
const AGGREGATE_BITS = 0, AGGREGATE_SIG = 1;
const HEADER_BEACON = 0;

const pubkeysOf = (committee: Uint8Array) => {
  const flat = mod.lcField(COMMITTEE, committee, COMMITTEE_PUBKEYS);
  const out: Uint8Array[] = [];
  for (let i = 0; i * 48 < flat.length; i++) out.push(flat.slice(i * 48, (i + 1) * 48));
  return out;
};
const participants = (keys: Uint8Array[], bits: Uint8Array) =>
  keys.filter((_, i) => (bits[i >> 3] & (1 << (i & 7))) !== 0);

Deno.test("the fork digest the vectors state is the one this computes", () => {
  // `meta.store_fork_digest` is the first four bytes of `hash_tree_root(ForkData(...))`, so it pins
  // the fork version *and* the ForkData merkleization at once — including that `Version` is four
  // bytes left-aligned in a chunk, which is easy to get stably wrong.
  for (const c of fixture.cases) {
    const gvr = un(c.meta.genesis_validators_root);
    const got = "0x" + hex(mod.lcForkDigest(mod.lcAltairVersionMinimal(), gvr));
    if (got !== c.meta.store_fork_digest) {
      throw new Error(`${c.case}: fork digest ${got}, the vector says ${c.meta.store_fork_digest}`);
    }
    if (got !== c.meta.bootstrap_fork_digest) {
      throw new Error(`${c.case}: bootstrap digest differs, so these cases span a fork upgrade`);
    }
  }
  // Mainnet's Altair version must give a different digest, or the version is not reaching the hash.
  const gvr = un(fixture.cases[0].meta.genesis_validators_root);
  if (hex(mod.lcForkDigest(mod.lcAltairVersionMainnet(), gvr)) ===
      hex(mod.lcForkDigest(mod.lcAltairVersionMinimal(), gvr))) {
    throw new Error("mainnet and minimal fork versions give the same digest");
  }
});

Deno.test("the domain is the type then twenty-eight bytes of the fork data root", () => {
  const gvr = un(fixture.cases[0].meta.genesis_validators_root);
  const version = mod.lcAltairVersionMinimal();
  const domain = mod.lcDomain(version, gvr);
  if (domain.length !== 32) throw new Error(`domain is ${domain.length} bytes`);
  if (hex(domain.slice(0, 4)) !== "07000000") {
    throw new Error(`domain type is ${hex(domain.slice(0, 4))}, expected DOMAIN_SYNC_COMMITTEE`);
  }
  const root = mod.lcForkDataRoot(version, gvr);
  if (hex(domain.slice(4)) !== hex(root.slice(0, 28))) {
    throw new Error("the domain does not carry the first 28 bytes of the fork data root");
  }
  // Truncated, not the whole root — a domain is not a hash and must not be treated as one.
  if (hex(domain.slice(4)) === hex(root)) throw new Error("the fork data root was not truncated");
});

Deno.test("every real sync-committee signature verifies", () => {
  // The whole stack in one assertion, over every update in every case.
  //
  // Which committee signs depends on the sync-committee period, and that rule belongs to the client,
  // which does not exist yet. What stands in for it is the store's actual behaviour: it starts with
  // the bootstrap's committee and *accumulates* each committee an update supplies. So the candidates
  // for update N are the bootstrap's plus every `next_sync_committee` seen before it.
  //
  // Accumulating is necessary rather than convenient: an update whose filename ends `_x` carries an
  // all-zero `next_sync_committee` — three of the sixteen do — and is signed by a committee an
  // *earlier* update supplied. Trying only the bootstrap's and the update's own fails those, which is
  // how this test found out.
  //
  // It is not weakened by choosing for the client: a wrong signing root, bit selection or extraction
  // fails against every candidate.
  let verified = 0, byBootstrap = 0, bySupplied = 0;
  for (const c of fixture.cases) {
    const gvr = un(c.meta.genesis_validators_root);
    const bootstrapKeys = pubkeysOf(
      mod.lcField(BOOTSTRAP, un(c.bootstrap), BOOTSTRAP_CURRENT_COMMITTEE),
    );
    if (bootstrapKeys.length !== 32) {
      throw new Error(`${c.case}: ${bootstrapKeys.length} pubkeys, expected 32 for minimal config`);
    }
    const supplied: Uint8Array[][] = [];

    for (const step of c.steps) {
      if (step.kind !== "process_update") continue;
      const upd = un(c.updates[step.update!]);
      const agg = mod.lcField(UPDATE, upd, UPDATE_SYNC_AGGREGATE);
      const bits = mod.lcField(AGGREGATE, agg, AGGREGATE_BITS);
      const sig = mod.lcField(AGGREGATE, agg, AGGREGATE_SIG);
      if (bits.length !== 4) throw new Error(`${c.case}: bits are ${bits.length} bytes, expected 4`);
      if (sig.length !== 96) throw new Error(`${c.case}: signature is ${sig.length} bytes`);

      const attested = mod.lcField(UPDATE, upd, UPDATE_ATTESTED);
      const beaconRoot = mod.lcFieldRoot(HEADER, attested, HEADER_BEACON);
      const signingRoot = mod.lcSigningRoot(beaconRoot, mod.lcAltairVersionMinimal(), gvr);
      if (signingRoot.length !== 32) throw new Error(`${c.case}: no signing root`);

      const ok = (keys: Uint8Array[]) =>
        keys.length > 0 && mod.lcFastAggregateVerify(participants(keys, bits), signingRoot, sig);
      if (ok(bootstrapKeys)) {
        byBootstrap++;
      } else if (supplied.some(ok)) {
        bySupplied++;
      } else {
        throw new Error(
          `${c.case}/${step.update}: verifies under none of ${1 + supplied.length} known committees`,
        );
      }
      verified++;

      // Whatever this update supplies becomes a candidate for the ones after it.
      const next = mod.lcField(UPDATE, upd, UPDATE_NEXT_COMMITTEE);
      if (!next.every((b) => b === 0)) supplied.push(pubkeysOf(next));
    }
  }
  if (verified !== 16) throw new Error(`verified ${verified} updates, expected 16`);
  // Both routes must occur, or "accumulate" is really "use the bootstrap's".
  if (byBootstrap === 0 || bySupplied === 0) {
    throw new Error(`bootstrap verified ${byBootstrap}, supplied ${bySupplied} — one is never used`);
  }
});

Deno.test("the signing root is what makes the signature context-specific", () => {
  // The point of the domain: the same header signed under a different fork or a different chain must
  // not verify. Without this, a signature could be replayed across contexts, and nothing else in the
  // suite would notice because every positive case uses the right domain.
  const c = fixture.cases[0];
  const gvr = un(c.meta.genesis_validators_root);
  const step = c.steps.find((s) => s.kind === "process_update")!;
  const upd = un(c.updates[step.update!]);
  const agg = mod.lcField(UPDATE, upd, UPDATE_SYNC_AGGREGATE);
  const bits = mod.lcField(AGGREGATE, agg, AGGREGATE_BITS);
  const sig = mod.lcField(AGGREGATE, agg, AGGREGATE_SIG);
  const beaconRoot = mod.lcFieldRoot(HEADER, mod.lcField(UPDATE, upd, UPDATE_ATTESTED), HEADER_BEACON);
  const keys = participants(
    pubkeysOf(mod.lcField(BOOTSTRAP, un(c.bootstrap), BOOTSTRAP_CURRENT_COMMITTEE)),
    bits,
  );

  const good = mod.lcSigningRoot(beaconRoot, mod.lcAltairVersionMinimal(), gvr);
  if (!mod.lcFastAggregateVerify(keys, good, sig)) throw new Error("the base case does not verify");

  // A different fork version — mainnet's Altair rather than minimal's.
  const wrongFork = mod.lcSigningRoot(beaconRoot, mod.lcAltairVersionMainnet(), gvr);
  if (mod.lcFastAggregateVerify(keys, wrongFork, sig)) {
    throw new Error("the signature verified under a different fork version");
  }
  // A different genesis validators root — a different chain with the same fork schedule.
  const otherChain = gvr.slice();
  otherChain[0] ^= 1;
  if (mod.lcFastAggregateVerify(keys, mod.lcSigningRoot(beaconRoot, mod.lcAltairVersionMinimal(), otherChain), sig)) {
    throw new Error("the signature verified against a different genesis validators root");
  }
  // And the header root itself must matter.
  const otherHeader = beaconRoot.slice();
  otherHeader[31] ^= 1;
  if (mod.lcFastAggregateVerify(keys, mod.lcSigningRoot(otherHeader, mod.lcAltairVersionMinimal(), gvr), sig)) {
    throw new Error("the signature verified over a different header root");
  }
});
