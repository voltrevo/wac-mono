// The light-client sync-protocol vectors, checked for shape.
//
// This asserts the *fixture*, not a client — `packages/lightclient` does not exist yet (wac-mono 0064).
// It is committed now because vendoring these is the hard half: the steps come from a restricted YAML
// that has no parser available here, so `tools/vendor.py` grew one, and a hand-written parser silently
// dropping a step would leave a client passing a shorter test than it thinks.
//
// The counts below were cross-checked against the raw YAML at vendoring time — every `- ` step and
// every `key:` accounted for, 10/10, 3/3, 5/5, 1/1 steps and 96/96, 28/28, 50/50, 10/10 keys.
//
// **Minimal config**, because the sync tests exist only there: SYNC_COMMITTEE_SIZE is 32 rather than
// 512. `src/beacon.wac` describes the mainnet layout, so a client driven by these needs a second
// descriptor table — which the bootstrap size proves is a real difference, not a nominal one.

import { fixtureJson, type FixtureManifest } from "../../../harness/fixtures.ts";
import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/ssz/test/wac/probe.wac") as unknown as {
  sszBeaconRootMinimal(ty: number, data: Uint8Array): Uint8Array;
  sszBeaconFixedSizeMinimal(ty: number): number;
  sszBeaconFixedSize(ty: number): number;
  sszTyFor(which: number): number;
  sszFieldMinimal(ty: number, data: Uint8Array, f: number): Uint8Array;
  sszFieldRootMinimal(ty: number, data: Uint8Array, f: number): Uint8Array;
};
const TY_BOOTSTRAP = mod.sszTyFor(5);
const TY_UPDATE = mod.sszTyFor(6);

const manifest = JSON.parse(
  await Deno.readTextFile(new URL("fixtures.json", import.meta.url)),
) as FixtureManifest;

type Step = {
  kind: string;
  current_slot?: string;
  update?: string;
  update_fork_digest?: string;
  checks?: {
    finalized_header?: { slot: string; beacon_root: string };
    optimistic_header?: { slot: string; beacon_root: string };
  };
};
type Case = {
  case: string;
  meta: Record<string, string>;
  steps: Step[];
  bootstrap: string;
  updates: Record<string, string>;
};

const fixture = await fixtureJson<{ cases: Case[] }>(
  "ssz",
  "light_client_sync_altair_minimal",
  manifest,
);

const HEX32 = /^0x[0-9a-f]{64}$/;

Deno.test("every sync case has the steps and updates the vendoring recorded", () => {
  const expected: Record<string, [number, number]> = {
    // case: [steps, distinct update files]
    light_client_sync: [10, 8],
    light_client_sync_no_force_update: [3, 2],
    advance_finality_without_sync_committee: [5, 5],
    supply_sync_committee_from_past_update: [1, 1],
  };
  if (fixture.cases.length !== 4) throw new Error(`${fixture.cases.length} cases, expected 4`);
  for (const c of fixture.cases) {
    const want = expected[c.case];
    if (want === undefined) throw new Error(`unexpected case ${c.case}`);
    if (c.steps.length !== want[0]) {
      throw new Error(`${c.case}: ${c.steps.length} steps, expected ${want[0]} — did the parser drop one?`);
    }
    if (Object.keys(c.updates).length !== want[1]) {
      throw new Error(`${c.case}: ${Object.keys(c.updates).length} updates, expected ${want[1]}`);
    }
  }
});

Deno.test("every step is one the sync protocol defines, and names data that is present", () => {
  const KINDS = new Set(["process_update", "force_update", "upgrade_store"]);
  for (const c of fixture.cases) {
    for (const [i, s] of c.steps.entries()) {
      const at = `${c.case}[${i}]`;
      if (!KINDS.has(s.kind)) throw new Error(`${at}: unknown step kind ${s.kind}`);
      // Every step drives the store to a slot, and every step asserts something about it — a step
      // with no checks would run and verify nothing.
      if (s.current_slot === undefined || !/^\d+$/.test(s.current_slot)) {
        throw new Error(`${at}: no current_slot`);
      }
      if (s.checks === undefined) throw new Error(`${at}: no checks, so it would assert nothing`);
      for (const which of ["finalized_header", "optimistic_header"] as const) {
        const h = s.checks[which];
        if (h === undefined) throw new Error(`${at}: no ${which} check`);
        if (!/^\d+$/.test(h.slot)) throw new Error(`${at}: ${which}.slot is ${h.slot}`);
        if (!HEX32.test(h.beacon_root)) throw new Error(`${at}: ${which}.beacon_root is not 32 bytes`);
      }
      if (s.kind === "process_update") {
        if (s.update === undefined) throw new Error(`${at}: a process_update with no update named`);
        if (c.updates[s.update] === undefined) {
          throw new Error(`${at}: names update ${s.update}, which was not vendored`);
        }
      }
    }
  }
});

Deno.test("the bootstrap and updates are minimal-config sizes", () => {
  // Minimal `LightClientBootstrap` = header 112 + SyncCommittee (32 pubkeys x 48 + 48 = 1584)
  // + branch 5 x 32 = 1856. That the vendored bytes are exactly this is the cheapest possible check
  // that the snappy decode is right *and* that these really are minimal-config objects — under
  // mainnet the same container is 24,896 bytes.
  const BOOTSTRAP = 112 + (32 * 48 + 48) + 5 * 32;
  if (BOOTSTRAP !== 1856) throw new Error("the arithmetic above is wrong");
  // Minimal `LightClientUpdate` = 112 + 1584 + 160 + 112 + 192 + (4 + 96) + 8.
  const UPDATE = 112 + (32 * 48 + 48) + 5 * 32 + 112 + 6 * 32 + (4 + 96) + 8;
  for (const c of fixture.cases) {
    if (c.bootstrap.length / 2 !== BOOTSTRAP) {
      throw new Error(`${c.case}: bootstrap is ${c.bootstrap.length / 2} bytes, expected ${BOOTSTRAP}`);
    }
    for (const [name, hex] of Object.entries(c.updates)) {
      if (hex.length / 2 !== UPDATE) {
        throw new Error(
          `${c.case}/${name}: update is ${hex.length / 2} bytes, expected ${UPDATE} for minimal config`,
        );
      }
    }
  }
});

Deno.test("the metadata carries what initialising a store needs", () => {
  for (const c of fixture.cases) {
    for (const k of ["genesis_validators_root", "trusted_block_root"]) {
      if (!HEX32.test(c.meta[k] ?? "")) throw new Error(`${c.case}: meta.${k} is not a 32-byte root`);
    }
    // The fork digests decide which container type an object is; a client that ignores them would
    // read a later fork's update as an altair one.
    for (const k of ["bootstrap_fork_digest", "store_fork_digest"]) {
      if (!/^0x[0-9a-f]{8}$/.test(c.meta[k] ?? "")) {
        throw new Error(`${c.case}: meta.${k} is not a 4-byte fork digest`);
      }
    }
  }
});

Deno.test("the minimal descriptor table reproduces the vendored objects' sizes", () => {
  // The reason `beaconTypes` takes a config at all. `SYNC_COMMITTEE_SIZE` is 32 here and 512 on
  // mainnet, and that changes the serialized size of everything holding a `SyncCommittee` — so the
  // same descriptor under the wrong config produces a wrong root *and* a wrong length, silently.
  //
  // Checked against the bytes Ethereum actually generated rather than against my arithmetic.
  const bootstrap = fixture.cases[0].bootstrap.length / 2;
  const update = Object.values(fixture.cases[0].updates)[0].length / 2;
  if (mod.sszBeaconFixedSizeMinimal(TY_BOOTSTRAP) !== bootstrap) {
    throw new Error(
      `minimal LightClientBootstrap: descriptor says ` +
        `${mod.sszBeaconFixedSizeMinimal(TY_BOOTSTRAP)}, the vectors are ${bootstrap}`,
    );
  }
  if (mod.sszBeaconFixedSizeMinimal(TY_UPDATE) !== update) {
    throw new Error(
      `minimal LightClientUpdate: descriptor says ` +
        `${mod.sszBeaconFixedSizeMinimal(TY_UPDATE)}, the vectors are ${update}`,
    );
  }
  // And the two configs must genuinely differ, or the parameter is doing nothing and both tables
  // would agree with whichever set of vectors happened to be checked first.
  if (mod.sszBeaconFixedSize(TY_BOOTSTRAP) === bootstrap) {
    throw new Error("the mainnet table also matches the minimal vectors — the config is ignored");
  }
});

Deno.test("every vendored bootstrap and update merkleizes under the minimal table", () => {
  // Not against a published root — the sync vectors give none — but every object must at least be
  // *readable* as the container it claims to be. A refusal here means a descriptor or a length is
  // wrong, and it would otherwise surface much later as a client that cannot start.
  let n = 0;
  for (const c of fixture.cases) {
    if (mod.sszBeaconRootMinimal(TY_BOOTSTRAP, hex(c.bootstrap)).length !== 32) {
      throw new Error(`${c.case}: the bootstrap was refused under the minimal table`);
    }
    n++;
    for (const [name, data] of Object.entries(c.updates)) {
      if (mod.sszBeaconRootMinimal(TY_UPDATE, hex(data)).length !== 32) {
        throw new Error(`${c.case}/${name}: the update was refused`);
      }
      n++;
    }
  }
  if (n !== 4 + 16) throw new Error(`merkleized ${n} objects, expected 20`);
});

function hex(h: string): Uint8Array {
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
}

// Field indices, in the order `src/beacon.wac` lists them.
const UPDATE_ATTESTED_HEADER = 0;
const UPDATE_SIGNATURE_SLOT = 6;
const HEADER_BEACON = 0;
const BEACON_SLOT = 0;

Deno.test("reading fields out of a real update agrees with the vectors' own checks", () => {
  // The oracle nobody had to write. A step's `checks.optimistic_header` states a slot and the
  // `hash_tree_root` of a beacon header — a value this package has to be able to extract — so field
  // access is checkable against Ethereum's own numbers rather than against a round trip through my
  // code.
  //
  // **The relationship is conditional, which I got wrong first.** After `process_update` the store's
  // optimistic header is the update's attested header only when the update actually advances it;
  // `supply_sync_committee_from_past_update` applies a *past* update, so the store keeps the later
  // header the bootstrap gave it and the check states slot 49 against the update's 32. That is the
  // protocol working, not the extraction failing.
  //
  // So the assertion is made where the slots agree — which is where the check is describing this
  // update's header — and the count below makes sure that is most of them rather than none.
  let matched = 0, seen = 0;
  for (const c of fixture.cases) {
    for (const step of c.steps) {
      if (step.kind !== "process_update") continue;
      const update = hex(c.updates[step.update!]);
      const want = step.checks!.optimistic_header!;

      const header = mod.sszFieldMinimal(TY_UPDATE, update, UPDATE_ATTESTED_HEADER);
      if (header.length === 0) throw new Error(`${c.case}: could not read attested_header`);
      const beacon = mod.sszFieldMinimal(mod.sszTyFor(4), header, HEADER_BEACON);
      const slotBytes = mod.sszFieldMinimal(mod.sszTyFor(0), beacon, BEACON_SLOT);
      if (slotBytes.length !== 8) throw new Error(`${c.case}: slot is ${slotBytes.length} bytes`);
      let slot = 0;
      for (let i = 7; i >= 0; i--) slot = slot * 256 + slotBytes[i];
      seen++;

      if (String(slot) !== want.slot) continue;      // a past update; the store did not adopt it
      const root = mod.sszFieldRootMinimal(mod.sszTyFor(4), header, HEADER_BEACON);
      if ("0x" + hexOf(root) !== want.beacon_root) {
        throw new Error(
          `${c.case} @ slot ${slot}: attested beacon root\n  got  0x${hexOf(root)}` +
            `\n  want ${want.beacon_root}`,
        );
      }
      matched++;
    }
  }
  if (seen < 15) throw new Error(`only ${seen} process_update steps found`);
  if (matched < 12) {
    throw new Error(
      `only ${matched} of ${seen} steps had the store adopt the update's header — too few for this ` +
        `to be testing extraction rather than skipping`,
    );
  }
});

Deno.test("signature_slot reads as a slot, and out-of-range fields are refused", () => {
  const c = fixture.cases[0];
  const update = hex(Object.values(c.updates)[0]);
  const slotBytes = mod.sszFieldMinimal(TY_UPDATE, update, UPDATE_SIGNATURE_SLOT);
  if (slotBytes.length !== 8) throw new Error(`signature_slot is ${slotBytes.length} bytes, expected 8`);
  let slot = 0;
  for (let i = 7; i >= 0; i--) slot = slot * 256 + slotBytes[i];
  // The spec requires signature_slot > attested_slot, so it is a real slot rather than zero padding.
  if (slot === 0 || slot > 1e9) throw new Error(`signature_slot is implausible: ${slot}`);

  for (const bad of [-1, 7, 99]) {
    if (mod.sszFieldMinimal(TY_UPDATE, update, bad).length !== 0) {
      throw new Error(`field index ${bad} returned bytes for a 7-field container`);
    }
  }
});

function hexOf(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}
