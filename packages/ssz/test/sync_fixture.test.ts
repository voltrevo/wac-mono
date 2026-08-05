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
