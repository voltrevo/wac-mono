// Who gets answered next, and in what order — one place, so it can be chosen rather than raced for.
//
// A worker makes progress only when the host answers a call it is parked on. So the order answers are
// *delivered* in is the order the whole system runs in, and today that order is whichever handler's
// promise resolved first — the kernel's business, not ours. Two bugs this repo has already paid for were
// interleavings that only happen sometimes: a zero-length write ending a stream when a reader happened to
// be parked (0078), and a corpus that hangs about once in fifty runs on an idle machine (0082).
//
// This is the seam. `respond.ts` hands a completed answer here instead of writing it, and the scheduler
// decides when it lands and which of several ready answers goes first.
//
// ## What it can and cannot promise — design/0001 D12
//
// **Owned:** which ready answer is delivered next, and therefore which ticket a `waitAny` sees when more
// than one has completed. The protocol permits either, so it is a genuine choice and today it is decided
// by timing.
//
// **Not owned:** whether a real `readFile`, `accept` or child exit has *completed*. That is the kernel's,
// so the set of answers available to choose from is not reproducible from a seed even though the choice
// among them is. A worker parked on two OS-backed tickets, one of which cannot complete until something
// else is unblocked, is indistinguishable from one that is merely slow.
//
// So: **deterministic over a world the scheduler owns** — an in-memory filesystem, a scripted network —
// and improved-but-not-guaranteed reproducibility over the real one. Saying more than that would be a
// claim the mode cannot keep, and a replay that sometimes fails is worse than no replay at all.
//
// ## The two policies
//
// - **`fifo`** — answers are delivered in the order they became ready. Canonical, boring, diffable.
// - **`seeded`** — chosen with a seeded generator from the ones ready *now*. Explores orderings a real
//   machine reaches rarely, and the same seed makes the same choices given the same choice set.
//
// **The default for suite runs is `seeded` with a fixed seed** — set in `tools/suiteGuard.ts`, so both
// `deno task test` and `deno task test:changed` carry it, and mutation runs inherit it too. Production is
// unscheduled, and so is anything driven through `packages/platform/test/worker.ts`, which is where the
// concurrent mode is tested on purpose. `WAC_SCHED=off|fifo|seed=N` overrides.
//
// ## Recording
//
// Because a seed cannot carry what the kernel decided, every choice is appended to a log. A run that
// wedges leaves the sequence of decisions behind, which replays where a seed might not — 0082 has been
// observed half a dozen times and never once with its interleaving in hand.

/** A completed answer waiting to be written into its slot. */
export type Pending = {
  /** Which bridge — a test process can be running several children at once. */
  readonly bridge: number;
  readonly slot: number;
  /** The order it became ready, for `fifo` and for the log. */
  readonly seq: number;
  /** Writes the answer into the slot and wakes the worker. */
  readonly deliver: () => void;
};

export type Policy = "off" | "fifo" | "seeded";

/** What the mode is, from the environment. `off` is production and any host outside a test. */
export function policyOf(): { policy: Policy; seed: number } {
  let raw = "";
  try {
    raw = Deno.env.get("WAC_SCHED") ?? "";
  } catch {
    return { policy: "off", seed: 0 };   // no --allow-env; scheduling is off, which is the normal case
  }
  if (raw === "off") return { policy: "off", seed: 0 };
  if (raw === "fifo") return { policy: "fifo", seed: 0 };
  const m = /^seed(?:=(\d+))?$/.exec(raw);
  if (m !== null) return { policy: "seeded", seed: m[1] === undefined ? DEFAULT_SEED : Number(m[1]) };
  return { policy: "off", seed: 0 };
}

/**
 * The seed tests use unless told otherwise.
 *
 * Fixed rather than random, so two runs of the suite make the same choices and a failure is somebody's
 * change rather than the draw. Chosen once, arbitrarily; there is nothing special about it, and a sweep
 * over seeds belongs in a soak run rather than in the gate.
 */
export const DEFAULT_SEED = 20260806;

/**
 * How long to wait for an answered worker to come back before letting somebody else go.
 *
 * Short, because it is only reached when a worker finishes without submitting again — a case the
 * responder gets no signal for. Long enough that an ordinary call's round trip is never mistaken for it.
 */
const IDLE_MS = 5;

/** xorshift32: small, and a seed really does reproduce the sequence. */
function rng(seed: number): () => number {
  let x = seed || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}

/**
 * The process-wide scheduler.
 *
 * Process-wide rather than per-bridge on purpose: a shell and the applets it spawns are several bridges,
 * and the interesting orderings are *between* them. A per-bridge scheduler would serialise each one and
 * leave the races that matter untouched.
 */
export class Scheduler {
  #policy: Policy;
  #next: () => number;
  #ready: Pending[] = [];
  #seq = 0;
  #log: string[] = [];

  constructor(policy: Policy, seed: number) {
    this.#policy = policy;
    this.#next = rng(seed);
  }

  get on(): boolean {
    return this.#policy !== "off";
  }

  /** The choices made, oldest first, for a run that has to be explained or replayed. */
  get log(): readonly string[] {
    return this.#log;
  }

  /**
   * An answer is ready.
   *
   * With scheduling off this writes it immediately, which is what the host has always done. With it on,
   * the answer joins the ready set and is delivered when this scheduler says.
   */
  ready(bridge: number, slot: number, deliver: () => void): void {
    if (this.#policy === "off") {
      deliver();
      return;
    }
    this.#ready.push({ bridge, slot, seq: this.#seq++, deliver });
    this.#pump();
  }

  /**
   * A bridge is running: it has been answered and has not yet come back.
   *
   * This is what "one worker at a time" is made of. A worker runs from the moment its answer lands until
   * it submits its next call or finishes, and while any worker is in that state no other is answered —
   * so two guests are never executing at once, whatever the operating system would have allowed.
   */
  #running = new Set<number>();

  /** Cleared by `respond.ts` when a sweep sees this bridge submit again, or when it stops. */
  quiet(bridge: number): void {
    if (!this.#running.delete(bridge)) return;
    this.#pump();
  }

  /**
   * Deliver at most one answer, to at most one worker.
   *
   * **Event-driven rather than timed.** The first version put a `setTimeout(0)` between deliveries as a
   * proxy for "wait until the worker comes back", which costs a millisecond of the event loop on *every
   * host call* — a program making fifty thousand of them would pay a minute for it. The proxy is not
   * needed: the responder already wakes when a worker submits, and that is exactly the signal that the
   * worker has gone quiet again.
   *
   * The one case with no such signal is a worker that finishes without submitting anything more. Its
   * result message is delivered elsewhere (`children.ts`), so a hurry-up timer covers it: if nothing has
   * come back within `IDLE_MS`, the mark is dropped and the next answer goes out. That clock cannot
   * decide anything — the worst it does is allow an ordering the policy did not choose, which is the
   * behaviour without a scheduler at all.
   */
  #pump(): void {
    if (this.#ready.length === 0) return;
    if (this.#running.size > 0) {
      this.#armIdle();
      return;
    }
    const at = this.#choose();
    if (at < 0) return;
    const [chosen] = this.#ready.splice(at, 1);
    this.#log.push(`${chosen.bridge}:${chosen.slot}@${chosen.seq}`);
    this.#running.add(chosen.bridge);
    chosen.deliver();
    this.#armIdle();
  }

  #idle: ReturnType<typeof setTimeout> | null = null;

  /** The hurry-up, armed only while something is waiting. Never more than one outstanding. */
  #armIdle(): void {
    if (this.#idle !== null || this.#running.size === 0) return;
    this.#idle = setTimeout(() => {
      this.#idle = null;
      // Whoever we were waiting for has not come back. Let the next answer go rather than stalling: an
      // ordering the policy did not pick is a weaker guarantee, and a stall is a broken test run.
      this.#running.clear();
      this.#pump();
    }, IDLE_MS);
    Deno.unrefTimer(this.#idle);
  }

  /** Which of the ready answers goes next. The whole of the policy is here. */
  #choose(): number {
    if (this.#ready.length === 0) return -1;
    if (this.#policy === "fifo") {
      // The one that became ready first. `#ready` is append-ordered, so that is index 0 — written as a
      // scan over `seq` anyway, because relying on the array's order would break silently the first time
      // somebody sorts it.
      let best = 0;
      for (let i = 1; i < this.#ready.length; i++) {
        if (this.#ready[i].seq < this.#ready[best].seq) best = i;
      }
      return best;
    }
    return this.#next() % this.#ready.length;
  }

  /**
   * Every bridge in this process, and how to describe it.
   *
   * A stall is almost never explainable from one bridge: a shell parked reading a child says nothing
   * about what the *child* is doing, and that is where a cycle closes. The scheduler already has to know
   * about every bridge, so it is the natural place to ask them all at once.
   */
  #bridges = new Map<number, () => string>();

  register(bridge: number, describe: () => string): void {
    this.#bridges.set(bridge, describe);
  }

  forget(bridge: number): void {
    this.#bridges.delete(bridge);
  }

  /** Every live bridge's state, for a caller explaining a stall. Reads only, and never throws. */
  survey(): string {
    const lines: string[] = [];
    for (const [id, describe] of this.#bridges) {
      try {
        lines.push(`    bridge ${id}: ${describe()}`);
      } catch {
        lines.push(`    bridge ${id}: <gone>`);
      }
    }
    return lines.join("\n");
  }

}

/** The one every host in this process shares. Built from the environment on first use. */
let shared: Scheduler | null = null;

export function scheduler(): Scheduler {
  if (shared === null) {
    const { policy, seed } = policyOf();
    shared = new Scheduler(policy, seed);
  }
  return shared;
}

/** For tests that need their own, with a policy of their own. */
export function newScheduler(policy: Policy, seed = DEFAULT_SEED): Scheduler {
  return new Scheduler(policy, seed);
}
