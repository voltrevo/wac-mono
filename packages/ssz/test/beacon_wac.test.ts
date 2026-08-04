// The light-client containers, against Ethereum's `ssz_static` vectors for the mainnet Altair config.
//
// These 45 cases are the reason the package exists: `LightClientUpdate` is what an Altair light client
// is handed by an untrusted peer, and its `hash_tree_root` is what a sync-committee signature is over.
// If any descriptor in `src/beacon.wac` is one index out, the root is wrong and self-consistent — the
// exact failure that vendoring these first was meant to catch.
//
// The serialized sizes are asserted separately from the roots, because they fail differently and one
// localises much better than the other. A wrong *size* means a wrong field list, and the size is
// computable from the descriptor alone; a wrong *root* with a right size means a wrong nesting or a
// wrong limit. Ethereum's own byte counts are 112 / 280 / 584 / 24,896 / 25,368, so the sizes are
// checkable against the fixtures rather than against my arithmetic.

import { wacBind } from "../../../harness/wacBind.ts";
import { fixtureJson, type FixtureManifest } from "../../../harness/fixtures.ts";

const manifest = JSON.parse(
  await Deno.readTextFile(new URL("fixtures.json", import.meta.url)),
) as FixtureManifest;


const mod = await wacBind("packages/ssz/test/wac/probe.wac") as unknown as {
  sszBeaconRoot(ty: number, data: Uint8Array): Uint8Array;
  sszBeaconFixedSize(ty: number): number;
  sszBeaconIsFixed(ty: number): boolean;
  sszTyFor(which: number): number;
};

/** In the order `sszTyFor` expects. */
const CONTAINERS = [
  "BeaconBlockHeader",
  "SigningData",
  "SyncCommittee",
  "SyncAggregate",
  "LightClientHeader",
  "LightClientBootstrap",
  "LightClientUpdate",
  "LightClientFinalityUpdate",
  "LightClientOptimisticUpdate",
];
const TY: Record<string, number> = {};
CONTAINERS.forEach((n, i) => TY[n] = mod.sszTyFor(i));

type Case = { container: string; case: string; ssz: string; root: string };
const fixture = await fixtureJson<{ cases: Case[] }>("ssz", "ssz_static_altair_mainnet", manifest);

const bytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

Deno.test("every light-client container merkleizes to Ethereum's root", () => {
  const per: Record<string, number> = {};
  const failures: string[] = [];
  for (const c of fixture.cases) {
    const ty = TY[c.container];
    if (ty === undefined) throw new Error(`no descriptor for ${c.container}`);
    per[c.container] = (per[c.container] ?? 0) + 1;
    const got = mod.sszBeaconRoot(ty, bytes(c.ssz));
    if (hex(got) !== c.root) {
      if (failures.length < 6) {
        failures.push(
          `${c.container}/${c.case}\n    got  ${got.length === 0 ? "(refused)" : hex(got)}` +
            `\n    want ${c.root}`,
        );
      }
    }
  }
  if (failures.length > 0) throw new Error(`${failures.length}+ mismatches:\n  ${failures.join("\n  ")}`);
  // Five cases per container, nine containers. Asserted so a container vanishing from the fixture is a
  // failure rather than a smaller, greener run.
  for (const name of CONTAINERS) {
    if (per[name] !== 5) throw new Error(`drove ${per[name] ?? 0} ${name} cases, expected 5`);
  }
});

Deno.test("the descriptors' serialized sizes are Ethereum's", () => {
  // Every light-client type is fixed-size — there is no list anywhere in them — so each descriptor
  // implies exactly one length, and the fixtures say what it should be. A size mismatch localises to a
  // wrong field list, where a root mismatch could be anything.
  const bySize = new Map<string, Set<number>>();
  for (const c of fixture.cases) {
    if (!bySize.has(c.container)) bySize.set(c.container, new Set());
    bySize.get(c.container)!.add(c.ssz.length / 2);
  }
  for (const [name, sizes] of bySize) {
    if (sizes.size !== 1) {
      throw new Error(`${name} fixtures disagree on the serialized size: ${[...sizes]}`);
    }
    const want = [...sizes][0];
    if (!mod.sszBeaconIsFixed(TY[name])) throw new Error(`${name} was classified variable-size`);
    const got = mod.sszBeaconFixedSize(TY[name]);
    if (got !== want) throw new Error(`${name}: descriptor says ${got} bytes, Ethereum's cases are ${want}`);
  }
  // The five figures the spec pins, so a re-vendor that changed config would be caught here too.
  const expected: Record<string, number> = {
    BeaconBlockHeader: 112,
    LightClientOptimisticUpdate: 280,
    LightClientFinalityUpdate: 584,
    LightClientBootstrap: 24896,
    LightClientUpdate: 25368,
  };
  for (const [name, n] of Object.entries(expected)) {
    if (mod.sszBeaconFixedSize(TY[name]) !== n) {
      throw new Error(`${name} is ${mod.sszBeaconFixedSize(TY[name])} bytes, expected ${n} for mainnet Altair`);
    }
  }
});

Deno.test("a wrong-length update is refused rather than merkleized", () => {
  // The light client is handed these by an untrusted peer, so a short or long buffer must be a refusal
  // and not a root over whatever happened to be there.
  const update = fixture.cases.find((c) => c.container === "LightClientUpdate");
  if (update === undefined) throw new Error("no LightClientUpdate case");
  const good = bytes(update.ssz);
  if (hex(mod.sszBeaconRoot(TY.LightClientUpdate, good)) !== update.root) {
    throw new Error("the unmodified case does not verify, so the negatives prove nothing");
  }
  for (const [why, data] of [
    ["one byte short", good.slice(0, good.length - 1)],
    ["one byte long", new Uint8Array([...good, 0])],
    ["empty", new Uint8Array(0)],
  ] as const) {
    if (mod.sszBeaconRoot(TY.LightClientUpdate, data).length !== 0) {
      throw new Error(`a LightClientUpdate ${why} was accepted`);
    }
  }
  // And a `SyncCommittee` is 512 pubkeys plus one: 511 must not pass as 512.
  const sc = fixture.cases.find((c) => c.container === "SyncCommittee")!;
  const short = bytes(sc.ssz).slice(0, bytes(sc.ssz).length - 48);
  if (mod.sszBeaconRoot(TY.SyncCommittee, short).length !== 0) {
    throw new Error("a SyncCommittee missing a pubkey was accepted");
  }
});
