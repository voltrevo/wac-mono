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
// ## Network down is not guard down
//
// A client that treats every failure as the guard's fault walks down its own preference list
// whenever the wifi drops, and comes back from a captive portal preferring its third guard
// having learnt nothing true. Worse, that is something an attacker can arrange: make the
// network look broken for two minutes and choose which of someone's guards they end up on.
//
// So when *every* sampled guard fails inside one short window, the conclusion is that the
// network is unreachable, and the individual marks are dropped rather than kept. See
// `markFailed`.
//
// ## What this is still not
//
// Proposal 271 also ages entries out of the sampled set on a schedule, keeps a confirmed
// list separate from a primary list, and bounds how much of the network a client may ever
// have sampled. This has the two properties that matter most — no rotation on failure, and
// no rotation on a network outage — and not the bookkeeping around them.

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
const portPermitted = mod.portPermitted as (
  isAccept: boolean, ranges: Int32Array, port: number,
) => boolean;

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
  /**
   * The port the circuit is for, so the exit is one whose policy will carry it.
   *
   * Optional, and its absence means "any exit will do" rather than "no port check" — for a
   * directory circuit, which never leaves the network, that is the truth. For a circuit
   * that will carry a stream, leaving it out picks exits that refuse the stream, and the
   * refusal looks like a flaky network rather than a mistake here.
   */
  port?: number;
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
    relays: Relay[], consensus: string, families?: Map<string, string[]>,
  ) {
    this.#relays = relays;
    // Declared families come off the microdescriptors unless the caller overrides them,
    // which only tests do. Before this they were never populated at all, so the family rule
    // was live code that no real data ever reached.
    const declared = families ?? new Map(
      relays.filter((r) => r.family !== undefined).map((r) => [r.nickname, r.family!]),
    );
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
    this.#family = resolveFamilies(relays, declared);
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
        (position !== POSITION.exit || this.#isExit[i] === 1) &&
        (position !== POSITION.exit || opts.port === undefined || this.#carries(i, opts.port));
      if (!eligible) weighted[i] = 0n;
    }
    return choose(
      weighted, Int32Array.from(chosen), this.#addresses,
      this.#family.start, this.#family.of,
      opts.allowSameSubnet ?? false, (opts.random ?? defaultRandom)(),
    );
  }

  /**
   * Whether relay `i` will carry `port`.
   *
   * A relay with the Exit flag but no policy summary is treated as carrying nothing. The
   * flag says the authorities saw it exit *something*; the summary says what. Assuming the
   * generous reading of a missing summary would send streams to relays that refuse them.
   */
  #carries(i: number, port: number): boolean {
    const policy = this.#relays[i].exitPolicy;
    if (policy === undefined) return false;
    return portPermitted(policy.isAccept, Int32Array.from(policy.ranges), port);
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

  /**
   * A path using the guard set, choosing the exit first.
   *
   * Exit first because it is the constrained position — it needs the flag, and a policy
   * carrying the port. Then the first sampled guard that can share a path with it: the
   * sampled set exists partly for this, and consulting it in preference order is what tor
   * does rather than drawing a fresh guard.
   *
   * Drawing a fresh guard here would be the mistake. The guard set is meant to be small and
   * stable; a client that topped it up whenever a path did not work out would enlarge its
   * exposure every time an exit was unavailable, which is a condition an attacker can
   * arrange.
   */
  pathWithGuards(guards: Relay[], opts: PathOptions = {}): Relay[] | null {
    if (guards.length === 0) return null;
    const exit = this.pick(POSITION.exit, [], opts);
    if (exit < 0) return null;
    for (const guard of guards) {
      const g = this.#relays.indexOf(guard);
      if (g < 0 || g === exit) continue;
      const middle = this.pick(POSITION.middle, [exit, g], opts);
      if (middle < 0) continue;
      // pick() has already applied the family and subnet rules against both, so reaching
      // here means the three are a legal path.
      return [guard, this.#relays[middle], this.#relays[exit]];
    }
    return null;
  }

  /** A path through one specific guard. */
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
  /**
   * When we concluded the network — rather than any guard — was unreachable.
   *
   * Set when every sampled guard fails inside one short window, and it clears the
   * individual marks. See `markFailed` for why that is not merely tidier.
   */
  netDownSince?: number;
};

/**
 * How close together every guard must fail before we blame the network instead.
 *
 * Long enough that three real timeouts fit inside it, short enough that three genuinely
 * dead guards spread over an afternoon are still read as dead guards.
 */
const NETWORK_DOWN_WINDOW_MS = 120_000;

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

/**
 * Record that a guard could not be reached.
 *
 * If that completes a set — every sampled guard failing inside one short window — the
 * conclusion changes. The likely explanation is no longer three unlucky relays but one
 * unreachable network: a captive portal, a dropped link, a firewall. So the individual
 * marks are cleared and `netDownSince` is set instead.
 *
 * Clearing them is the point rather than housekeeping. Left in place, the client comes back
 * from a coffee-shop portal preferring its third guard over its first, having learnt nothing
 * true — and an attacker who can make your network look down for two minutes gets to walk
 * you down your own preference list. Proposal 271 spends most of its length on this
 * distinction; this is the part of it that matters.
 */
export function markFailed(state: GuardState, relay: Relay, now: number = Date.now()): GuardState {
  const failed = { ...state.failed, [fpOf(relay)]: now };
  const allDownRecently = state.sampled.length > 0 &&
    state.sampled.every((fp) => (failed[fp] ?? 0) > now - NETWORK_DOWN_WINDOW_MS);
  if (allDownRecently) {
    return { sampled: state.sampled, failed: {}, netDownSince: now };
  }
  return { sampled: state.sampled, failed, netDownSince: state.netDownSince };
}

/**
 * Record that a guard worked, which also settles that the network is up.
 *
 * One reachable guard is proof the network is not down, and that is worth acting on: it
 * means any failure recorded during the supposed outage was about the guard after all.
 */
export function markWorking(state: GuardState, relay: Relay): GuardState {
  const failed = { ...state.failed };
  delete failed[fpOf(relay)];
  return { sampled: state.sampled, failed, netDownSince: undefined };
}

/** Whether we currently believe the network, rather than our guards, is unreachable. */
export function networkSeemsDown(state: GuardState): boolean {
  return state.netDownSince !== undefined;
}
