// The whole light client, driven by Ethereum's own sync-protocol vectors.
//
// Four cases, nineteen steps. Each step feeds a real `LightClientUpdate` — SSZ bytes produced by a
// beacon node — into the store and states what `finalized_header` and `optimistic_header` must be
// afterwards. Nothing here is synthetic: the signatures are real BLS signatures by real sync
// committees over real headers, and the branches are real Merkle proofs into real beacon states.
//
// This is the test the package exists to pass. It exercises, per step and in one call:
//
//   - `packages/ssz` container parsing, offsets and merkleization, on nine beacon types;
//   - normalized Merkle branch verification against a state root the client never sees;
//   - fork data root, domain and signing root;
//   - `packages/bls` `FastAggregateVerify` over the participating subset of a 32-key committee.
//
// The four cases are chosen upstream to hit the parts of the state machine that a happy path misses:
//
//   - `light_client_sync` walks several committee periods, so it exercises rotation;
//   - `light_client_sync_no_force_update` reaches a `force_update` that must do **nothing**, which is
//     the only test of the timeout's lower bound — a client that forces eagerly passes every other
//     case in this file;
//   - `advance_finality_without_sync_committee` advances finality across a period with updates that
//     carry no committee, so the store's committee must stay put;
//   - `supply_sync_committee_from_past_update` applies an update from an *earlier* slot to learn a
//     committee, which is why the optimistic header does not simply track the last update seen.
//
// The fixture set lives in `packages/ssz`'s manifest because `packages/ssz/tools/vendor.py` is what
// derives it — the YAML step parser is there. Reading a sibling package's manifest is the smaller
// wrong than a second generator that could drift from it.

import { fixtureJson, type FixtureManifest } from "../../../harness/fixtures.ts";
import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/lightclient/test/wac/probe.wac") as unknown as {
  lcInit(trustedRoot: Uint8Array, bootstrap: Uint8Array): unknown | null;
  lcProcess(s: unknown, update: Uint8Array, currentSlot: bigint, gvr: Uint8Array): boolean;
  lcForce(s: unknown, currentSlot: bigint): void;
  lcFinalizedSlot(s: unknown): bigint;
  lcFinalizedRoot(s: unknown): Uint8Array;
  lcOptimisticSlot(s: unknown): bigint;
  lcOptimisticRoot(s: unknown): Uint8Array;
  lcSafetyThreshold(s: unknown): number;
  lcHasSupermajority(bits: Uint8Array, active: number): boolean;
  lcIsBetterUpdate(a: Uint8Array, b: Uint8Array): boolean;
  lcCountBits(bits: Uint8Array): number;
};

// `LightClientUpdate` is entirely fixed-size in Altair — `LightClientHeader` is just a
// `BeaconBlockHeader` — so every field is at a known offset and a test can reach one without
// re-serializing. 112 + 1584 + 160 + 112 + 192 + 100 + 8.
const UPDATE_SIZE = 2268;
const ATTESTED_SLOT_AT = 0;               // attested_header.beacon.slot, uint64 LE
const SIGNATURE_AT = 2268 - 8 - 96;       // sync_aggregate.sync_committee_signature
const SIGNATURE_SLOT_AT = 2268 - 8;

const manifest = JSON.parse(
  await Deno.readTextFile(new URL("../../ssz/test/fixtures.json", import.meta.url)),
) as FixtureManifest;

type Header = { slot: string; beacon_root: string };
type Step = {
  kind: string;
  current_slot?: string;
  update?: string;
  checks?: { finalized_header?: Header; optimistic_header?: Header };
};
type Case = {
  case: string;
  meta: { genesis_validators_root: string; trusted_block_root: string };
  steps: Step[];
  bootstrap: string;
  updates: Record<string, string>;
};

const bytes = (h: string) =>
  Uint8Array.from((h.startsWith("0x") ? h.slice(2) : h).match(/../g)!.map((x) => parseInt(x, 16)));
const hex = (b: Uint8Array) => "0x" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

const fixture = await fixtureJson<{ source: string; cases: Case[] }>(
  "ssz",
  "light_client_sync_altair_minimal",
  manifest,
);

/** Runs a case's steps, returning what each check saw. Shared so the fault-plant test can reuse it. */
function runCase(c: Case): { step: number; kind: string; fin: string; opt: string }[] {
  const store = mod.lcInit(bytes(c.meta.trusted_block_root), bytes(c.bootstrap));
  if (store === null) throw new Error(`${c.case}: the bootstrap did not initialize a store`);
  const gvr = bytes(c.meta.genesis_validators_root);
  const seen: { step: number; kind: string; fin: string; opt: string }[] = [];

  c.steps.forEach((s, i) => {
    const slot = BigInt(s.current_slot!);
    if (s.kind === "process_update") {
      const update = c.updates[s.update!];
      if (update === undefined) throw new Error(`${c.case} step ${i}: no update ${s.update}`);
      // A vector's `process_update` steps are all expected to be *accepted*: upstream's invalid
      // updates live in separate test suites. So a false here is a failure, not a datum.
      if (!mod.lcProcess(store, bytes(update), slot, gvr)) {
        throw new Error(`${c.case} step ${i}: the client rejected a valid update (${s.update})`);
      }
    } else if (s.kind === "force_update") {
      mod.lcForce(store, slot);
    } else {
      throw new Error(`${c.case} step ${i}: unhandled step kind ${s.kind}`);
    }
    seen.push({
      step: i,
      kind: s.kind,
      fin: `${mod.lcFinalizedSlot(store)}@${hex(mod.lcFinalizedRoot(store))}`,
      opt: `${mod.lcOptimisticSlot(store)}@${hex(mod.lcOptimisticRoot(store))}`,
    });
  });
  return seen;
}

/** What the vectors say a step's checks are, in the same string form. */
function expected(s: Step): { fin: string; opt: string } {
  const f = s.checks!.finalized_header!, o = s.checks!.optimistic_header!;
  return { fin: `${f.slot}@${f.beacon_root}`, opt: `${o.slot}@${o.beacon_root}` };
}

Deno.test("every light-client sync vector step agrees, header for header", () => {
  let steps = 0, forced = 0;
  for (const c of fixture.cases) {
    const seen = runCase(c);
    c.steps.forEach((s, i) => {
      const want = expected(s);
      const got = seen[i];
      if (got.fin !== want.fin || got.opt !== want.opt) {
        throw new Error(
          `${c.case} step ${i} (${s.kind}, current_slot ${s.current_slot}):\n` +
            `  finalized  got ${got.fin}\n             want ${want.fin}\n` +
            `  optimistic got ${got.opt}\n             want ${want.opt}`,
        );
      }
      steps++;
      if (s.kind === "force_update") forced++;
    });
  }
  // Counts stated so a fixture that silently loses steps fails rather than passing faster. These are
  // the numbers `packages/ssz/test/sync_fixture.test.ts` cross-checked against the raw YAML.
  if (fixture.cases.length !== 4) throw new Error(`expected 4 cases, ran ${fixture.cases.length}`);
  if (steps !== 19) throw new Error(`expected 19 steps, ran ${steps}`);
  if (forced !== 3) throw new Error(`expected 3 force_update steps, ran ${forced}`);
});

Deno.test("the store rejects an update whose signature is not by its committee", () => {
  // The test above proves the client accepts good updates; it cannot prove it would reject a bad one,
  // because the vectors contain none. Without this, a `validateUpdate` that returned true
  // unconditionally would pass every step — the headers would still be right, because they come from
  // the update rather than from the check.
  //
  // The bit flipped has to be *in the signature*. The first version of this test flipped the last
  // byte, on the assumption that the signature was the trailing field. It is not: the last eight
  // bytes are `signature_slot`, so the update was rejected for claiming a slot around 2^56 and the
  // BLS check never ran. The offsets above are asserted below so that cannot recur silently.
  const c = fixture.cases[0];
  const gvr = bytes(c.meta.genesis_validators_root);
  const first = c.steps.find((s) => s.kind === "process_update")!;
  const good = bytes(c.updates[first.update!]);
  const slot = BigInt(first.current_slot!);

  if (good.length !== UPDATE_SIZE) {
    throw new Error(`update is ${good.length} bytes, not ${UPDATE_SIZE}: the offsets below are wrong`);
  }
  const le = (b: Uint8Array, at: number) =>
    Number(new DataView(b.buffer, b.byteOffset).getBigUint64(at, true));
  if (le(good, SIGNATURE_SLOT_AT) !== Number(slot)) {
    throw new Error(
      `bytes at ${SIGNATURE_SLOT_AT} read ${le(good, SIGNATURE_SLOT_AT)}, but the vector's ` +
        `current_slot is ${slot} and a signature slot is at most that — the layout has moved`,
    );
  }

  const fresh = () => mod.lcInit(bytes(c.meta.trusted_block_root), bytes(c.bootstrap))!;
  const store = fresh();
  if (!mod.lcProcess(store, good, slot, gvr)) {
    throw new Error("the unmodified update was rejected, so the negative below proves nothing");
  }

  // Every byte of the 96-byte signature, one at a time, would be slow; the first, a middle and the
  // last cover the compressed-point flags, the x coordinate and the y parity.
  for (const at of [SIGNATURE_AT, SIGNATURE_AT + 48, SIGNATURE_AT + 95]) {
    const bad = good.slice();
    bad[at] ^= 0x01;
    const s2 = fresh();
    if (mod.lcProcess(s2, bad, slot, gvr)) {
      throw new Error(`an update with signature byte ${at - SIGNATURE_AT} corrupted was accepted`);
    }
    if (mod.lcFinalizedSlot(s2) !== mod.lcFinalizedSlot(fresh())) {
      throw new Error("a rejected update advanced the finalized header");
    }
  }
});

Deno.test("the two participation thresholds are what the spec says, not what the vectors need", () => {
  // Both thresholds survive every vector when weakened: `light_client_sync`'s updates are signed by
  // almost the whole committee, so `>= 2/3` and `>= 1/3` accept the same set, and the safety
  // threshold is passed whether it is `max/2` or zero. Mutating either one is invisible to the
  // step-by-step test above. That is a limit of the vector set, not of the client, so the two
  // predicates are pinned directly here.
  const bits = (n: number, of = 32) => {
    const b = new Uint8Array(of / 8);
    for (let i = 0; i < n; i++) b[i >> 3] |= 1 << (i & 7);
    return b;
  };
  if (mod.lcCountBits(bits(21)) !== 21) throw new Error("countBits disagrees with the fixture");

  // 32 members: two thirds is 21.33, so 22 is the first supermajority and 21 is not.
  for (const [n, want] of [[32, true], [22, true], [21, false], [16, false], [11, false], [0, false]] as const) {
    if (mod.lcHasSupermajority(bits(n), n) !== want) {
      throw new Error(`${n}/32 participants: supermajority reported ${!want}, want ${want}`);
    }
  }
  // The boundary explicitly, since off-by-one here is the whole risk: 2*32 = 64, 21*3 = 63 < 64.
  if (mod.lcHasSupermajority(bits(21), 21)) throw new Error("21 of 32 counted as a supermajority");
  if (!mod.lcHasSupermajority(bits(22), 22)) throw new Error("22 of 32 did not count as one");

  // And the safety threshold is half the best participation, not zero and not the count itself.
  // Driven through a real store: process the case's first update, whose participation is known.
  const c = fixture.cases[0];
  const store = mod.lcInit(bytes(c.meta.trusted_block_root), bytes(c.bootstrap))!;
  const first = c.steps.find((s) => s.kind === "process_update")!;
  const update = bytes(c.updates[first.update!]);
  const active = mod.lcCountBits(update.slice(SIGNATURE_AT - 4, SIGNATURE_AT));
  if (active === 0) throw new Error("read zero participants from the aggregate — offsets are wrong");
  if (mod.lcSafetyThreshold(store) !== 0) throw new Error("a fresh store has a non-zero threshold");
  mod.lcProcess(store, update, BigInt(first.current_slot!), bytes(c.meta.genesis_validators_root));
  if (mod.lcSafetyThreshold(store) !== Math.floor(active / 2)) {
    throw new Error(
      `after one update with ${active} participants the threshold is ` +
        `${mod.lcSafetyThreshold(store)}, want ${Math.floor(active / 2)}`,
    );
  }
});

Deno.test("is_better_update prefers the earlier of two otherwise identical updates", () => {
  // The last two tiebreakers — prefer the *older* attested header, then the *older* signature slot —
  // only decide anything when every earlier criterion ties, which no pair of real updates does. So
  // reversing them passes every vector.
  //
  // `isBetterUpdate` reads only slots, branches and bits — it never verifies a signature — so a copy
  // of a real update with its slots bumped is a legitimate input, even though it would never validate.
  const c = fixture.cases[0];
  const step = c.steps.find((s) => s.kind === "process_update")!;
  const older = bytes(c.updates[step.update!]);
  const put = (b: Uint8Array, at: number, v: number) =>
    new DataView(b.buffer, b.byteOffset).setBigUint64(at, BigInt(v), true);
  const get = (b: Uint8Array, at: number) =>
    Number(new DataView(b.buffer, b.byteOffset).getBigUint64(at, true));

  const attested = get(older, ATTESTED_SLOT_AT);
  const signature = get(older, SIGNATURE_SLOT_AT);
  // Stay inside the same sync-committee period (64 slots) so only the tiebreakers differ.
  if (Math.floor((attested + 1) / 64) !== Math.floor(attested / 64)) {
    throw new Error("the chosen update sits on a period boundary; pick another");
  }

  const newerAttested = older.slice();
  put(newerAttested, ATTESTED_SLOT_AT, attested + 1);
  if (!mod.lcIsBetterUpdate(older, newerAttested)) {
    throw new Error("the update with the earlier attested header was not preferred");
  }
  if (mod.lcIsBetterUpdate(newerAttested, older)) {
    throw new Error("the ordering is not antisymmetric on the attested-slot tiebreak");
  }

  const newerSig = older.slice();
  put(newerSig, SIGNATURE_SLOT_AT, signature + 1);
  if (!mod.lcIsBetterUpdate(older, newerSig)) {
    throw new Error("the update with the earlier signature slot was not preferred");
  }
  if (mod.lcIsBetterUpdate(newerSig, older)) {
    throw new Error("the ordering is not antisymmetric on the signature-slot tiebreak");
  }
  // An update is not better than itself: every criterion ties all the way down.
  if (mod.lcIsBetterUpdate(older, older)) throw new Error("an update is better than itself");
});

Deno.test("the store rejects an update whose branches do not prove what it claims", () => {
  // The signature covers the **attested** header and nothing else. A peer may therefore attach any
  // `finalized_header` and any `next_sync_committee` it likes to a perfectly-signed update, and the
  // only thing standing between the client and those bytes is the Merkle branch. Disabling the
  // finality branch check survives every other test in this file, which is why this one is separate.
  //
  // Fixed offsets, from the layout asserted above:
  //   0      attested_header            112
  //   112    next_sync_committee       1584
  //   1696   next_sync_committee_branch 160
  //   1856   finalized_header           112
  //   1968   finality_branch            192
  //   2160   sync_aggregate             100
  //   2260   signature_slot               8
  const FINALIZED_AT = 1856, FINALITY_BRANCH_AT = 1968, NEXT_COMMITTEE_AT = 112, NEXT_BRANCH_AT = 1696;

  const c = fixture.cases[0];
  const gvr = bytes(c.meta.genesis_validators_root);
  const step = c.steps.find((s) => s.kind === "process_update")!;
  const good = bytes(c.updates[step.update!]);
  const slot = BigInt(step.current_slot!);
  const fresh = () => mod.lcInit(bytes(c.meta.trusted_block_root), bytes(c.bootstrap))!;

  if (!mod.lcProcess(fresh(), good, slot, gvr)) throw new Error("the base update was rejected");

  // Perturbations chosen so that *only* a branch can catch them. The finalized header's body_root
  // (offset 80 within the header) is not read by any slot check, and a branch node is not read at
  // all outside the proof — so if either is accepted, the corresponding branch is not being verified.
  const plants: [string, number][] = [
    ["the finalized header's body_root", FINALIZED_AT + 80],
    ["the finalized header's state_root", FINALIZED_AT + 48],
    ["the first finality branch node", FINALITY_BRANCH_AT],
    ["the last finality branch node", FINALITY_BRANCH_AT + 191],
    ["a next_sync_committee public key", NEXT_COMMITTEE_AT + 24],
    ["the aggregate public key", NEXT_COMMITTEE_AT + 1584 - 24],
    ["the first next-committee branch node", NEXT_BRANCH_AT],
  ];
  for (const [what, at] of plants) {
    const bad = good.slice();
    bad[at] ^= 0x01;
    if (mod.lcProcess(fresh(), bad, slot, gvr)) {
      throw new Error(
        `an update with ${what} corrupted (byte ${at}) was accepted — the signature does not cover ` +
          `it, so the branch that should have caught it is not being verified`,
      );
    }
  }
});

Deno.test("a bootstrap whose committee is not proven by its branch does not make a store", () => {
  // The bootstrap is the root of all the client's trust: everything later is signed by the committee
  // it yields. The trusted block root check catches a *substituted* bootstrap, but not a genuine
  // header carrying somebody else's committee — only the branch does that, and disabling it passes
  // every sync vector, since real bootstraps are internally consistent.
  //
  //   0     header                       112
  //   112   current_sync_committee      1584
  //   1696  current_sync_committee_branch 160
  const c = fixture.cases[0];
  const root = bytes(c.meta.trusted_block_root);
  const good = bytes(c.bootstrap);
  if (good.length !== 1856) throw new Error(`bootstrap is ${good.length} bytes, not 1856`);
  if (mod.lcInit(root, good) === null) throw new Error("the real bootstrap did not initialize");

  for (const [what, at] of [
    ["a committee public key", 112],
    ["the aggregate public key", 112 + 1584 - 1],
    ["the first branch node", 1696],
    ["the last branch node", 1855],
  ] as [string, number][]) {
    const bad = good.slice();
    bad[at] ^= 0x01;
    if (mod.lcInit(root, bad) !== null) {
      throw new Error(`a bootstrap with ${what} corrupted produced a store — the branch is not checked`);
    }
  }
  // And a bootstrap for the wrong block is refused even though it is internally consistent.
  const wrongRoot = root.slice();
  wrongRoot[0] ^= 0x01;
  if (mod.lcInit(wrongRoot, good) !== null) {
    throw new Error("a bootstrap was accepted against a block root it does not hash to");
  }
});

Deno.test("the slot ordering is strict where the spec is strict", () => {
  // `current_slot >= signature_slot > attested_slot >= finalized_slot`. The middle relation is the
  // strict one and it is the one worth planting: an update signed in the *same* slot it attests to
  // has not observed that slot's block, so accepting it lets a committee attest to a block it has
  // not seen. Slots are not signed over, so a copy with them rewritten is a legitimate input and the
  // signature still verifies — which is exactly what makes this reachable and worth checking.
  const c = fixture.cases[0];
  const gvr = bytes(c.meta.genesis_validators_root);
  const step = c.steps.find((s) => s.kind === "process_update")!;
  const good = bytes(c.updates[step.update!]);
  const fresh = () => mod.lcInit(bytes(c.meta.trusted_block_root), bytes(c.bootstrap))!;
  const put = (b: Uint8Array, at: number, v: number) =>
    new DataView(b.buffer, b.byteOffset).setBigUint64(at, BigInt(v), true);
  const get = (b: Uint8Array, at: number) =>
    Number(new DataView(b.buffer, b.byteOffset).getBigUint64(at, true));

  const attested = get(good, ATTESTED_SLOT_AT);
  const current = Number(step.current_slot);
  if (!mod.lcProcess(fresh(), good, BigInt(current), gvr)) throw new Error("the base update failed");

  // signature_slot == attested_slot: must be refused, and is otherwise a perfectly valid update.
  const same = good.slice();
  put(same, SIGNATURE_SLOT_AT, attested);
  if (mod.lcProcess(fresh(), same, BigInt(current), gvr)) {
    throw new Error("an update signed in the slot it attests to was accepted");
  }
  // signature_slot < attested_slot: refused for the same reason, more obviously.
  const before = good.slice();
  put(before, SIGNATURE_SLOT_AT, attested - 1);
  if (mod.lcProcess(fresh(), before, BigInt(current), gvr)) {
    throw new Error("an update signed before the slot it attests to was accepted");
  }
  // current_slot < signature_slot: an update from the future, refused.
  if (mod.lcProcess(fresh(), good, BigInt(get(good, SIGNATURE_SLOT_AT) - 1), gvr)) {
    throw new Error("an update from a slot later than the current one was accepted");
  }
});

Deno.test("an update nobody signed is refused", () => {
  // Zero participants. The refusal is doubly determined — `MIN_SYNC_COMMITTEE_PARTICIPANTS` catches
  // it first, and `fastAggregateVerify` refuses an empty key list rather than returning the identity
  // — so removing either check leaves the behaviour intact. That redundancy is deliberate and is why
  // this test pins the *outcome* rather than claiming to exercise one check.
  const c = fixture.cases[0];
  const gvr = bytes(c.meta.genesis_validators_root);
  const step = c.steps.find((s) => s.kind === "process_update")!;
  const bad = bytes(c.updates[step.update!]);
  for (let i = 0; i < 4; i++) bad[SIGNATURE_AT - 4 + i] = 0;   // sync_committee_bits, 32 bits
  const store = mod.lcInit(bytes(c.meta.trusted_block_root), bytes(c.bootstrap))!;
  if (mod.lcProcess(store, bad, BigInt(step.current_slot!), gvr)) {
    throw new Error("an update with no participants was accepted");
  }
});
