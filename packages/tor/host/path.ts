// Building a path, and keeping a guard.
//
// The arithmetic and the constraints are in `src/pathsel.wac`; this resolves the consensus
// into the arrays that takes, and holds the guard set across circuits.
//
// ## Why the first hop is pinned
//
// Suppose you picked all three hops afresh every time. An adversary running a fraction `f`
// of the network sees your first hop with probability `f` per circuit — so over enough
// circuits they see it *eventually*, with probability approaching one. Pinning the first
// hop turns that into a single sample: either your guard is theirs, with probability `f`,
// or it never is. The total compromise probability does not fall, but it stops accumulating
// with use, which for a client that builds circuits all day is the whole difference.
//
// So a guard is not a performance choice and rotating it "for freshness" is actively
// harmful. This keeps a small sampled set and prefers the first one that works.
//
// ## What this is not
//
// Real Tor's guard algorithm (proposal 271) is considerably more careful: it tracks
// reachability over time, distinguishes "the network is down" from "this guard is down" so
// that a captive portal cannot force rotation, and ages entries out of a sampled set on a
// schedule. This samples, persists and prefers. The distinction that matters is that it does
// not rotate on failure alone — see `markFailed`.

import { wacBind } from "../../../harness/wacBind.ts";
import type { Relay } from "./directory.ts";

const mod = await wacBind("packages/tor/test/wac/pathsel_probe.wac");
const weightedBandwidths = mod.weightedBandwidths as (
  bandwidth: BigInt64Array, isGuard: Int32Array, isExit: Int32Array,
  position: number, weights: BigInt64Array,
) => BigInt64Array;
const choose = mod.choose as (
  weighted: BigInt64Array, chosen: Int32Array, addresses: Uint8Array,
  familyStart: Int32Array, familyOf: Int32Array, allowSameSubnet: boolean, r: bigint,
) => number;

export const POSITION = { guard: 0, middle: 1, exit: 2 } as const;

/** The weights in the order `pathsel.wac` expects: four per position. */
const WEIGHT_ORDER = [
  "Wgg", "Wgd", "Wge", "Wgm",
  "Wmg", "Wmd", "Wme", "Wmm",
  "Weg", "Wed", "Wee", "Wem",
] as const;

/**
 * The `bandwidth-weights` line, or the neutral weights if the consensus has none.
 *
 * Falling back to 10000 everywhere — plain bandwidth, no position balancing — rather than
 * refusing. A consensus without weights is old rather than hostile, and the values it would
 * have carried are public information that an attacker gains nothing by withholding.
 */
export function parseWeights(consensus: string): BigInt64Array {
  const line = consensus.match(/^bandwidth-weights (.+)$/m);
  const found = new Map<string, bigint>();
  if (line !== null) {
    for (const pair of line[1].split(" ")) {
      const [k, v] = pair.split("=");
      if (v !== undefined && /^-?\d+$/.test(v)) found.set(k, BigInt(v));
    }
  }
  return BigInt64Array.from(WEIGHT_ORDER.map((k) => {
    const v = found.get(k) ?? 10000n;
    // A negative weight would make `weightedChoice` trap. The authorities do not publish
    // them; a peer that does is either broken or probing, and zero is the safe reading.
    return v < 0n ? 0n : v;
  }));
}

/** Consensus bandwidth per relay, keyed by nickname order in the document. */
export function parseBandwidths(consensus: string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  let current: string | null = null;
  for (const line of consensus.split("\n")) {
    if (line.startsWith("r ")) current = line.split(" ")[1];
    else if (line.startsWith("w ") && current !== null) {
      const m = line.match(/Bandwidth=(\d+)/);
      out.set(current, m === null ? 0n : BigInt(m[1]));
      current = null;
    }
  }
  return out;
}

/**
 * Mutual families, as indices into `relays`.
 *
 * One-sided declarations are dropped. A relay claiming kinship it is not owed would
 * otherwise shrink everyone's candidate set for free, which is a cheap way to push clients
 * onto the relays an attacker does run.
 */
export function resolveFamilies(
  relays: Relay[], declared: Map<string, string[]>,
): { start: Int32Array; of: Int32Array } {
  const byName = new Map(relays.map((r, i) => [r.nickname, i]));
  const byFingerprint = new Map(
    relays.map((r, i) => ["$" + [...r.identity].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase(), i]),
  );
  const resolve = (token: string): number | undefined =>
    byFingerprint.get(token.toUpperCase().split("~")[0].split("=")[0]) ?? byName.get(token);

  const claims = relays.map((r) =>
    new Set((declared.get(r.nickname) ?? []).map(resolve).filter((i): i is number => i !== undefined))
  );

  const start = new Int32Array(relays.length + 1);
  const of: number[] = [];
  for (let i = 0; i < relays.length; i++) {
    start[i] = of.length;
    for (const j of claims[i]) {
      if (j !== i && claims[j].has(i)) of.push(j);   // mutual only
    }
  }
  start[relays.length] = of.length;
  return { start, of: Int32Array.from(of) };
}

export type PathOptions = {
  /** Testnets put every relay on 127.0.0.1, where the /16 rule rejects every path. */
  allowSameSubnet?: boolean;
  /** Injectable for tests; must be uniform over the full range. */
  random?: () => bigint;
};

const defaultRandom = (): bigint => {
  const b = crypto.getRandomValues(new Uint8Array(8));
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v & 0x7FFFFFFFFFFFFFFFn;   // non-negative, since the wac side takes an i64
};

/** Everything the chooser needs about a set of relays, computed once. */
export class PathChooser {
  #relays: Relay[];
  #bandwidth: BigInt64Array;
  #isGuard: Int32Array;
  #isExit: Int32Array;
  #addresses: Uint8Array;
  #weights: BigInt64Array;
  #family: { start: Int32Array; of: Int32Array };

  constructor(
    relays: Relay[], consensus: string, families: Map<string, string[]> = new Map(),
  ) {
    this.#relays = relays;
    const bw = parseBandwidths(consensus);
    this.#bandwidth = BigInt64Array.from(relays.map((r) => bw.get(r.nickname) ?? 0n));
    // Running and Valid are the flags that say a relay is usable at all; a client that
    // ignores them will keep choosing relays the authorities have already written off.
    const usable = (r: Relay) => r.flags.includes("Running") && r.flags.includes("Valid");
    this.#isGuard = Int32Array.from(relays.map((r) =>
      usable(r) && r.flags.includes("Guard") && r.ntorOnionKey !== undefined ? 1 : 0
    ));
    this.#isExit = Int32Array.from(relays.map((r) =>
      usable(r) && r.flags.includes("Exit") && !r.flags.includes("BadExit") ? 1 : 0
    ));
    this.#addresses = new Uint8Array(relays.length * 4);
    relays.forEach((r, i) => {
      const o = r.address.split(".").map(Number);
      if (o.length === 4) this.#addresses.set(Uint8Array.from(o), i * 4);
    });
    this.#weights = parseWeights(consensus);
    this.#family = resolveFamilies(relays, families);
  }

  get relays(): Relay[] {
    return this.#relays;
  }

  /**
   * Pick one relay for a position, given what the path already holds.
   *
   * Returns -1 when nothing is eligible — no relay with the flags, or none left that the
   * subnet and family rules permit. The caller must treat that as "no path", not retry with
   * the rules relaxed.
   */
  pick(position: number, chosen: number[], opts: PathOptions = {}): number {
    // A relay with no onion key cannot be handshaked with, whatever its flags say. Its
    // microdescriptor simply has not been fetched.
    const weighted = weightedBandwidths(
      this.#bandwidth, this.#isGuard, this.#isExit, position, this.#weights,
    );
    for (let i = 0; i < weighted.length; i++) {
      const r = this.#relays[i];
      const eligible = r.ntorOnionKey !== undefined &&
        r.flags.includes("Running") && r.flags.includes("Valid") &&
        (position !== POSITION.guard || this.#isGuard[i] === 1) &&
        (position !== POSITION.exit || this.#isExit[i] === 1);
      if (!eligible) weighted[i] = 0n;
    }
    return choose(
      weighted, Int32Array.from(chosen), this.#addresses,
      this.#family.start, this.#family.of,
      opts.allowSameSubnet ?? false, (opts.random ?? defaultRandom)(),
    );
  }

  /**
   * A three-hop path: guard, middle, exit.
   *
   * Chosen exit-first. The exit is the most constrained position — it needs the flag, and in
   * a real client a policy permitting the port — so choosing it last means discovering after
   * two picks that nothing is left, and the natural fix for that is to relax a rule.
   */
  buildPath(opts: PathOptions = {}): Relay[] | null {
    const exit = this.pick(POSITION.exit, [], opts);
    if (exit < 0) return null;
    const guard = this.pick(POSITION.guard, [exit], opts);
    if (guard < 0) return null;
    const middle = this.pick(POSITION.middle, [exit, guard], opts);
    if (middle < 0) return null;
    return [this.#relays[guard], this.#relays[middle], this.#relays[exit]];
  }

  /** A path through a guard already chosen. */
  pathThroughGuard(guard: Relay, opts: PathOptions = {}): Relay[] | null {
    const g = this.#relays.indexOf(guard);
    if (g < 0) return null;
    const exit = this.pick(POSITION.exit, [g], opts);
    if (exit < 0) return null;
    const middle = this.pick(POSITION.middle, [g, exit], opts);
    if (middle < 0) return null;
    return [guard, this.#relays[middle], this.#relays[exit]];
  }
}

// ── Guards ───────────────────────────────────────────────────────────────────

export type GuardState = {
  /** Sampled guards, in preference order, by identity fingerprint hex. */
  sampled: string[];
  /** Fingerprints currently believed unreachable, and when we last thought so. */
  failed: Record<string, number>;
};

const GUARD_SET_SIZE = 3;

const fpOf = (r: Relay) =>
  [...r.identity].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();

/**
 * Sample a guard set, keeping any already-sampled guards that are still listed.
 *
 * Keeping them is the point: a guard set that is resampled whenever the consensus changes
 * is not a guard set. New entries are only added to top the set back up to its size.
 */
export function sampleGuards(
  chooser: PathChooser, state: GuardState, opts: PathOptions = {},
): GuardState {
  const stillListed = new Set(chooser.relays.map(fpOf));
  const sampled = state.sampled.filter((fp) => stillListed.has(fp));

  while (sampled.length < GUARD_SET_SIZE) {
    const taken = sampled
      .map((fp) => chooser.relays.findIndex((r) => fpOf(r) === fp))
      .filter((i) => i >= 0);
    const i = chooser.pick(POSITION.guard, taken, opts);
    if (i < 0) break;   // fewer guards available than we would like, which is not an error
    sampled.push(fpOf(chooser.relays[i]));
  }
  return { sampled, failed: state.failed };
}

/**
 * The first sampled guard that is listed and not currently believed down.
 *
 * Falls back to the first listed guard when all of them are marked failed, rather than
 * sampling a new one. If every guard looks down the likely explanation is that the network
 * is unreachable, and a client that responded by picking fresh guards would hand an attacker
 * a way to churn them: block the real ones and wait to be chosen.
 */
export function currentGuard(
  chooser: PathChooser, state: GuardState, now: number = Date.now(),
): Relay | null {
  const listed = state.sampled
    .map((fp) => chooser.relays.find((r) => fpOf(r) === fp))
    .filter((r): r is Relay => r !== undefined);
  if (listed.length === 0) return null;
  // An hour before retrying one that failed, so a transient blip does not pin us to the
  // second choice forever.
  const usable = listed.filter((r) => (now - (state.failed[fpOf(r)] ?? 0)) > 3600_000);
  return usable.length > 0 ? usable[0] : listed[0];
}

export function markFailed(state: GuardState, relay: Relay, now: number = Date.now()): GuardState {
  return { sampled: state.sampled, failed: { ...state.failed, [fpOf(relay)]: now } };
}

export function markWorking(state: GuardState, relay: Relay): GuardState {
  const failed = { ...state.failed };
  delete failed[fpOf(relay)];
  return { sampled: state.sampled, failed };
}
