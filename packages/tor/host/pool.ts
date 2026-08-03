// Keeping circuits, and deciding which one a stream goes on.
//
// Every circuit so far has been built for one purpose and dropped. That is wasteful — a
// circuit costs three handshakes and a round trip per hop — but the reason to fix it is not
// the waste, and the fix has to be careful, because "reuse the circuit" and "keep the
// circuit forever" are one small step apart and the second is a real leak.
//
// ## Why circuits are retired
//
// Everything sent over one circuit shares an exit, and the exit sees the plaintext
// destination of all of it. So a circuit that lives all day tells its exit relay the whole
// day's browsing, linked together as one person's. Retiring after ten minutes bounds how
// much any single exit gets to correlate. tor calls this MaxCircuitDirtiness and the default
// has been ten minutes for as long as it has existed.
//
// Retirement is about *new* streams. A download running for an hour keeps its circuit; what
// stops is anything else joining it.
//
// ## Isolation
//
// Two streams that must not be linked must not share a circuit. tor's default isolates by
// client address, SOCKS credentials and protocol — but *not* by destination, deliberately:
// isolating every site onto its own circuit would build circuits faster than the network can
// absorb, and Tor Browser instead isolates by first-party domain, which is a judgement about
// what "linked" means that only the application can make.
//
// So this takes an isolation key from the caller and guarantees that two different keys
// never share a circuit. It does not guess one. A caller who passes nothing gets one shared
// pool, which is what tor does by default and is the wrong default for a browser.

import { Circuit } from "./circuit.ts";
import { createCircuit, linkHandshake, type Link } from "./link.ts";
import type { Relay } from "./directory.ts";
import {
  currentGuard, type GuardState, markFailed, markWorking, type PathOptions, PathChooser,
} from "./path.ts";

/** tor's MaxCircuitDirtiness. Ten minutes, and it is a bound on correlation, not a timeout. */
export const MAX_DIRTINESS_MS = 600_000;

type Entry = {
  circuit: Circuit;
  link: Link;
  path: Relay[];
  isolation: string;
  /** When the first stream attached, or null while the circuit is still clean. */
  firstUsed: number | null;
  /** Set when the circuit has failed; it is kept out of selection but not closed twice. */
  broken: boolean;
};

export type PoolOptions = PathOptions & {
  /** Overridable so the retirement rule can be tested without waiting ten minutes. */
  now?: () => number;
  /** How many attempts to build a circuit before giving up. */
  attempts?: number;
};

/**
 * Which existing circuit a stream may use, if any.
 *
 * Separated from the building because it is the part with the policy in it and the part
 * worth testing: no network, no clock of its own, and every input explicit.
 *
 * A circuit is usable when it matches the isolation key, is not broken, and either has never
 * carried a stream or first carried one less than MaxCircuitDirtiness ago. The oldest usable
 * one is preferred, so circuits are used up and retired in order rather than one being kept
 * permanently warm while the rest expire unused.
 */
export function selectCircuit<T extends {
  isolation: string;
  firstUsed: number | null;
  broken: boolean;
}>(entries: T[], isolation: string, now: number): T | null {
  const usable = entries.filter((e) =>
    !e.broken &&
    e.isolation === isolation &&
    (e.firstUsed === null || now - e.firstUsed < MAX_DIRTINESS_MS)
  );
  if (usable.length === 0) return null;
  // Dirty before clean, oldest first: a clean circuit is worth saving for a stream that
  // finds nothing else, and among dirty ones the oldest is closest to retirement anyway.
  usable.sort((a, b) => (a.firstUsed ?? Infinity) - (b.firstUsed ?? Infinity));
  return usable[0];
}

/** Circuits that can no longer take a new stream and are carrying nothing. */
export function retirable<T extends { firstUsed: number | null; broken: boolean }>(
  entries: T[], now: number, busy: (e: T) => boolean,
): T[] {
  return entries.filter((e) =>
    e.broken ||
    (e.firstUsed !== null && now - e.firstUsed >= MAX_DIRTINESS_MS && !busy(e))
  );
}

export class CircuitPool {
  #chooser: PathChooser;
  #guards: GuardState;
  #opts: PoolOptions;
  #entries: Entry[] = [];
  #open = new Map<Entry, number>();   // how many streams are still running on each

  constructor(chooser: PathChooser, guards: GuardState, opts: PoolOptions = {}) {
    this.#chooser = chooser;
    this.#guards = guards;
    this.#opts = opts;
  }

  get guards(): GuardState {
    return this.#guards;
  }

  /** For tests and for reporting: the paths currently held, oldest first. */
  get paths(): Relay[][] {
    return this.#entries.filter((e) => !e.broken).map((e) => e.path);
  }

  #now(): number {
    return (this.#opts.now ?? Date.now)();
  }

  /**
   * Build one circuit, updating what we believe about the guard either way.
   *
   * A failure marks the guard, which is what feeds the network-down detection: three of
   * these inside two minutes and the client stops blaming its guards. A success clears the
   * mark, because one reachable guard settles that the network is up.
   */
  async #build(isolation: string): Promise<Entry> {
    const attempts = this.#opts.attempts ?? 3;
    let last: Error | null = null;
    for (let i = 0; i < attempts; i++) {
      const guardList = this.#guardRelays();
      const path = this.#chooser.pathWithGuards(guardList, this.#opts);
      if (path === null) throw new Error("no path satisfies the constraints");
      try {
        const link = await linkHandshake(path[0].address, path[0].orPort);
        const hop = await createCircuit(link, {
          identity: path[0].identity,
          ntorOnionKey: path[0].ntorOnionKey!,
        });
        const circuit = new Circuit(link, hop.circId, hop.keys);
        for (const r of path.slice(1)) {
          await circuit.extend({
            address: r.address, orPort: r.orPort,
            identity: r.identity, ntorOnionKey: r.ntorOnionKey!,
          });
        }
        this.#guards = markWorking(this.#guards, path[0]);
        const entry: Entry = { circuit, link, path, isolation, firstUsed: null, broken: false };
        this.#entries.push(entry);
        return entry;
      } catch (e) {
        last = e as Error;
        this.#guards = markFailed(this.#guards, path[0], this.#now());
      }
    }
    throw new Error(`could not build a circuit after ${attempts} attempts: ${last?.message}`);
  }

  #guardRelays(): Relay[] {
    // In preference order, starting from the one `currentGuard` would pick — so a guard
    // believed down is tried last rather than not at all.
    const first = currentGuard(this.#chooser, this.#guards, this.#now());
    const rest = this.#chooser.relays.filter((r) => {
      const fp = [...r.identity].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
      return this.#guards.sampled.includes(fp) && r !== first;
    });
    return first === null ? rest : [first, ...rest];
  }

  /** A circuit for this isolation key, reusing one if the rules allow. */
  async circuitFor(isolation = "default"): Promise<Circuit> {
    await this.#retire();
    const existing = selectCircuit(this.#entries, isolation, this.#now());
    const entry = existing ?? await this.#build(isolation);
    if (entry.firstUsed === null) entry.firstUsed = this.#now();
    return entry.circuit;
  }

  /**
   * Open a stream, on a circuit chosen for the isolation key.
   *
   * `hostPort` also sets the exit constraint: the path is only rebuilt for a port the
   * existing circuit's exit cannot carry when there is no existing circuit, so a caller
   * mixing ports under one isolation key can still be handed an exit that refuses one of
   * them. That is a real limitation and it is why `isolation` defaults to shared rather than
   * to per-port — a caller who cares should say so.
   */
  async stream(hostPort: string, isolation = "default"): Promise<
    { circuit: Circuit; streamId: number }
  > {
    const port = Number(hostPort.split(":").pop());
    const previous = this.#opts.port;
    if (Number.isFinite(port)) this.#opts = { ...this.#opts, port };
    try {
      const circuit = await this.circuitFor(isolation);
      const entry = this.#entries.find((e) => e.circuit === circuit)!;
      this.#open.set(entry, (this.#open.get(entry) ?? 0) + 1);
      try {
        return { circuit, streamId: await circuit.begin(hostPort) };
      } catch (e) {
        this.#open.set(entry, (this.#open.get(entry) ?? 1) - 1);
        throw e;
      }
    } finally {
      this.#opts = { ...this.#opts, port: previous };
    }
  }

  /** Tell the pool a stream has ended, so its circuit can be retired when due. */
  release(circuit: Circuit): void {
    const entry = this.#entries.find((e) => e.circuit === circuit);
    if (entry === undefined) return;
    this.#open.set(entry, Math.max(0, (this.#open.get(entry) ?? 1) - 1));
  }

  /** Mark a circuit unusable — it has failed, and nothing new should be attached to it. */
  markBroken(circuit: Circuit): void {
    const entry = this.#entries.find((e) => e.circuit === circuit);
    if (entry !== undefined) entry.broken = true;
  }

  async #retire(): Promise<void> {
    const due = retirable(this.#entries, this.#now(), (e) => (this.#open.get(e) ?? 0) > 0);
    for (const entry of due) {
      this.#entries = this.#entries.filter((e) => e !== entry);
      this.#open.delete(entry);
      try {
        entry.link.conn.close();
      } catch {
        // Already gone. Retirement is bookkeeping; a closed socket is the desired end state
        // however it got there.
      }
    }
  }

  async close(): Promise<void> {
    for (const entry of this.#entries) {
      try {
        entry.link.conn.close();
      } catch { /* see #retire */ }
    }
    this.#entries = [];
    this.#open.clear();
  }
}
