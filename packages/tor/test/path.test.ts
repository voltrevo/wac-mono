// Host-side path selection: family mutuality, weight parsing, and guard stability.
//
// These stay in TypeScript because they are parsing and bookkeeping over strings and maps —
// the arithmetic and the constraint checks live in `wac/pathsel_test.wac`, which is where
// the policy is. The split is the same one the rest of the package uses.
//
// Every test here is about a way of being *too permissive*, because that is the direction
// these functions fail in: a family rule that does not exclude, a guard set that rotates, a
// weight that defaults high. None of those break a circuit.

import type { Relay } from "../host/directory.ts";
import {
  currentGuard, markFailed, markWorking, parseWeights, PathChooser, resolveFamilies,
  sampleGuards,
} from "../host/path.ts";

// Local, because the sandbox cannot reach jsr and the repo's other TypeScript tests do the
// same. Comparing through JSON so arrays and typed arrays are compared by value.
function assert(cond: boolean, msg = "assertion failed"): void {
  if (!cond) throw new Error(msg);
}
function assertEquals<T>(got: T, want: T, msg?: string): void {
  const g = JSON.stringify(got, (_, v) => typeof v === "bigint" ? `${v}n` : v);
  const w = JSON.stringify(want, (_, v) => typeof v === "bigint" ? `${v}n` : v);
  if (g !== w) {
    throw new Error(`${msg ?? "assertEquals failed"}\n  got:  ${g}\n  want: ${w}`);
  }
}

const relay = (nickname: string, address: string, flags: string[], id = 0): Relay => ({
  nickname,
  identity: Uint8Array.from({ length: 20 }, (_, i) => (id * 31 + i) & 0xFF),
  address,
  orPort: 9001,
  flags,
  microdescDigest: nickname,
  ntorOnionKey: new Uint8Array(32),
});

const FLAGS = ["Running", "Valid", "Fast", "Stable"];

Deno.test("a family claim counts only when it is mutual", () => {
  const relays = [
    relay("alpha", "10.0.0.1", FLAGS, 1),
    relay("beta", "20.0.0.1", FLAGS, 2),
    relay("gamma", "30.0.0.1", FLAGS, 3),
  ];
  // alpha and beta declare each other. gamma claims alpha, unrequited.
  const declared = new Map([
    ["alpha", ["beta"]],
    ["beta", ["alpha"]],
    ["gamma", ["alpha"]],
  ]);
  const { start, of } = resolveFamilies(relays, declared);

  const familyOf = (i: number) => [...of.slice(start[i], start[i + 1])].sort();
  assertEquals(familyOf(0), [1], "alpha's family is beta and not gamma");
  assertEquals(familyOf(1), [0], "beta's is alpha");
  assertEquals(
    familyOf(2),
    [],
    "gamma's one-sided claim on alpha is dropped — otherwise anyone could shrink " +
      "everyone's candidate set by claiming kinship they are not owed",
  );
});

Deno.test("a family member named by fingerprint is resolved too", () => {
  const relays = [relay("alpha", "10.0.0.1", FLAGS, 1), relay("beta", "20.0.0.1", FLAGS, 2)];
  const fp = (r: Relay) =>
    "$" + [...r.identity].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  // Real consensuses use $FINGERPRINT, sometimes with a =nickname or ~nickname suffix.
  const declared = new Map([
    ["alpha", [fp(relays[1]) + "=beta"]],
    ["beta", [fp(relays[0])]],
  ]);
  const { start, of } = resolveFamilies(relays, declared);
  assertEquals([...of.slice(start[0], start[1])], [1], "alpha's family resolved by fingerprint");
  assertEquals([...of.slice(start[1], start[2])], [0], "and beta's");
});

Deno.test("a self-claim does not make a relay its own family", () => {
  const relays = [relay("alpha", "10.0.0.1", FLAGS, 1)];
  const { start, of } = resolveFamilies(relays, new Map([["alpha", ["alpha"]]]));
  assertEquals([...of.slice(start[0], start[1])], [], "a relay is not excluded from itself here");
});

Deno.test("missing bandwidth weights fall back to neutral, not to zero or to a default set", () => {
  const neutral = parseWeights("network-status-version 3\n");
  assertEquals([...neutral], new Array(12).fill(10000n), "plain bandwidth when none published");

  const parsed = parseWeights("bandwidth-weights Wgg=5000 Wed=1234 Wee=9999\n");
  assertEquals(parsed[0], 5000n, "Wgg");
  assertEquals(parsed[9], 1234n, "Wed");
  assertEquals(parsed[10], 9999n, "Wee");
  assertEquals(parsed[1], 10000n, "an absent weight is neutral rather than zero");
});

Deno.test("a negative published weight is clamped, not passed through to trap", () => {
  const w = parseWeights("bandwidth-weights Wgg=-1 Wgd=-99999\n");
  assertEquals(w[0], 0n);
  assertEquals(w[1], 0n);
});

// ── Guards ───────────────────────────────────────────────────────────────────

const guardRelays = () => [
  relay("g1", "10.0.0.1", [...FLAGS, "Guard"], 1),
  relay("g2", "11.0.0.1", [...FLAGS, "Guard"], 2),
  relay("g3", "12.0.0.1", [...FLAGS, "Guard"], 3),
  relay("g4", "13.0.0.1", [...FLAGS, "Guard"], 4),
  relay("m1", "14.0.0.1", FLAGS, 5),
];

/**
 * A consensus listing exactly these relays, all equal bandwidth.
 *
 * Generated from the relay list rather than written out, because a relay missing from it
 * gets bandwidth zero and is silently never chosen. That is correct behaviour and it made a
 * hand-written fixture here fail in a way that looked like a selection bug.
 */
const consensusFor = (relays: Relay[]) =>
  [
    "network-status-version 3",
    ...relays.map((r) =>
      `r ${r.nickname} x 2026-01-01 00:00:00 ${r.address} ${r.orPort} 0\nw Bandwidth=100`
    ),
    "bandwidth-weights Wgg=10000 Wgd=10000 Wge=10000 Wgm=10000 " +
    "Wmg=10000 Wmd=10000 Wme=10000 Wmm=10000 Weg=10000 Wed=10000 Wee=10000 Wem=10000",
  ].join("\n");

const CONSENSUS = consensusFor(guardRelays());

Deno.test("a guard set is stable across resampling — that is the entire point", () => {
  const chooser = new PathChooser(guardRelays(), CONSENSUS);
  let state = sampleGuards(chooser, { sampled: [], failed: {} });
  assertEquals(state.sampled.length, 3, "three guards sampled");

  const first = [...state.sampled];
  for (let i = 0; i < 20; i++) state = sampleGuards(chooser, state);
  assertEquals(
    state.sampled,
    first,
    "resampling twenty times changes nothing; a guard set that churns is not a guard set",
  );
});

Deno.test("a guard that leaves the consensus is dropped and the set topped back up", () => {
  const all = guardRelays();
  const chooser = new PathChooser(all, CONSENSUS);
  const state = sampleGuards(chooser, { sampled: [], failed: {} });

  // Rebuild without the first sampled guard.
  const fpOf = (r: Relay) =>
    [...r.identity].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  const gone = state.sampled[0];
  const remaining = all.filter((r) => fpOf(r) !== gone);
  const smaller = new PathChooser(remaining, CONSENSUS);

  const after = sampleGuards(smaller, state);
  assert(!after.sampled.includes(gone), "the delisted guard is gone");
  assertEquals(after.sampled.length, 3, "and the set is topped back up");
  assertEquals(
    after.sampled.slice(0, 2),
    state.sampled.slice(1),
    "the survivors keep their order rather than being reshuffled",
  );
});

Deno.test("a failed guard is skipped but not replaced", () => {
  const relays = guardRelays();
  const chooser = new PathChooser(relays, CONSENSUS);
  const state = sampleGuards(chooser, { sampled: [], failed: {} });
  const first = currentGuard(chooser, state)!;
  assert(first !== null);

  const now = 1_000_000_000_000;
  const afterFailure = markFailed(state, first, now);
  const second = currentGuard(chooser, afterFailure, now)!;
  assert(second.nickname !== first.nickname, "a different guard is preferred");
  assertEquals(
    afterFailure.sampled,
    state.sampled,
    "but the sampled set is unchanged — failure must not cause rotation, or an attacker " +
      "who can block your guards gets to choose the replacement",
  );

  // And it comes back after the retry interval.
  const later = currentGuard(chooser, afterFailure, now + 3600_001)!;
  assertEquals(later.nickname, first.nickname, "retried an hour on");
  assertEquals(
    currentGuard(chooser, markWorking(afterFailure, first), now)!.nickname,
    first.nickname,
    "or immediately once it is seen working",
  );
});

Deno.test("when every guard looks down, we return one anyway rather than sampling fresh", () => {
  const chooser = new PathChooser(guardRelays(), CONSENSUS);
  let state = sampleGuards(chooser, { sampled: [], failed: {} });
  const now = 1_000_000_000_000;
  for (const fp of state.sampled) state = { ...state, failed: { ...state.failed, [fp]: now } };

  const g = currentGuard(chooser, state, now);
  assert(g !== null, "still a guard, because the likely explanation is that the net is down");
  const resampled = sampleGuards(chooser, state);
  assertEquals(resampled.sampled, state.sampled, "and no fresh guards are drawn");
});

// ── Paths ────────────────────────────────────────────────────────────────────

Deno.test("a built path has three distinct relays on distinct /16s", () => {
  const relays = [
    relay("g1", "10.0.0.1", [...FLAGS, "Guard"], 1),
    relay("g2", "10.0.0.2", [...FLAGS, "Guard"], 2), // same /16 as g1
    relay("m1", "11.0.0.1", FLAGS, 3),
    relay("m2", "12.0.0.1", FLAGS, 4),
    relay("e1", "13.0.0.1", [...FLAGS, "Exit"], 5),
  ];
  const chooser = new PathChooser(relays, consensusFor(relays));
  for (let i = 0; i < 50; i++) {
    const path = chooser.buildPath();
    if (path === null) throw new Error("no path was found");
    assertEquals(new Set(path.map((r) => r.nickname)).size, 3, "three distinct relays");
    const prefixes = path.map((r) => r.address.split(".").slice(0, 2).join("."));
    assertEquals(new Set(prefixes).size, 3, "on three distinct /16s");
    assert(path[2].flags.includes("Exit"), "and the last one can exit");
  }
});

Deno.test("no path is reported as null rather than as a path breaking the rules", () => {
  // Two relays in one /16 and no exit at all: there is no legal path, and the honest answer
  // is to say so. A client that relaxed a rule here would be silently less anonymous.
  const pair = [
    relay("a", "10.0.0.1", [...FLAGS, "Guard"], 1),
    relay("b", "10.0.0.2", FLAGS, 2),
  ];
  const chooser = new PathChooser(pair, consensusFor(pair));
  assertEquals(chooser.buildPath(), null);
});

Deno.test("a relay with no onion key is never chosen, whatever its flags say", () => {
  // Its microdescriptor has not been fetched, so the handshake could not happen — but the
  // flags look fine, so nothing else would exclude it.
  const relays = guardRelays();
  relays[0].ntorOnionKey = undefined;
  const chooser = new PathChooser(relays, CONSENSUS);
  for (let i = 0; i < 100; i++) {
    assert(chooser.pick(0, []) !== 0, "the keyless relay is not picked");
  }
});
