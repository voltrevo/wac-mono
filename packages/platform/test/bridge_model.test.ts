// The bridge's slot protocol, walked rather than sampled.
//
// The third layer, after the queue and the child's lifecycle. A slot is shared memory written by two
// agents that never take turns: the worker claims, fills, publishes and later collects; the host sweeps,
// takes, works and answers. Which of them acts next is the hardware's business, and the code's comments
// record what that has already cost —
//
//   - a plain store where a compare-and-exchange belongs overwrote `ST_CANCELLED` with `ST_RUNNING`, and
//     the slot was owned by nobody for the life of the program;
//   - one state for "claimed" and "pending" together let a sweep dispatch a slot whose opcode had not
//     been written yet, which surfaced as `no handler for capability 0` — invisible at four slots,
//     reproducible within three runs at sixteen.
//
// Both were found by a fuzzer, eventually. This walks the state space instead: every interleaving of the
// two agents' steps over one slot, to a bounded depth, against the rules that must hold in all of them.
//
// **What this covers and what it cannot.** It is a model of the *protocol* — who may move a slot from
// which state to which, and what each side may conclude. It says nothing about memory ordering: a plain
// load where an `Atomics` one belongs, or a torn read of the payload, is invisible here and is only ever
// caught by the real thing under stress. The comments above are protocol bugs; that is the class this
// catches.

import {
  ST_CANCELLED,
  ST_CLAIMED,
  ST_FREE,
  ST_PENDING,
  ST_READY,
  ST_RUNNING,
} from "../host/layout.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

/**
 * One slot, and what each side believes about it.
 *
 * `gen` is not decoration: slots are reused, and a ticket held across a reuse would read whatever call now
 * occupies the slot — an answer that looks plausible, which is the worst kind.
 */
type Slot = {
  status: number;
  gen: number;
  /** What the worker wrote, or null when the slot holds no request. */
  op: number | null;
  /** What the host wrote back, or null when there is no answer in it. */
  answer: number | null;
  /** The generation the worker's outstanding ticket was taken at, or null when it holds none. */
  ticket: number | null;
  /** Whether the host is mid-handler for this slot. */
  hostWorking: boolean;
  /** What the worker collected, for the invariant that it is never somebody else's answer. */
  collected: number | null;
};

const fresh = (): Slot => ({
  status: ST_FREE,
  gen: 0,
  op: null,
  answer: null,
  ticket: null,
  hostWorking: false,
  collected: null,
});

/** A step either side may take. Guards say when it is possible; `go` is what it does. */
type Move = {
  readonly show: string;
  readonly by: "worker" | "host";
  readonly can: (s: Slot) => boolean;
  readonly go: (s: Slot) => Slot;
};

/** The opcode the worker writes, and the answer the host writes for it — distinct so a mix-up shows. */
const OP = 7;
const ANSWER = 700;

const MOVES: readonly Move[] = [
  {
    show: "worker: claim",
    by: "worker",
    can: (s) => s.status === ST_FREE && s.ticket === null,
    // Claimed, *not* pending: between taking a slot and writing the opcode there is nothing to take, and
    // sharing one state is what let a sweep dispatch a slot whose opcode was still the previous call's.
    go: (s) => ({ ...s, status: ST_CLAIMED, op: null, answer: null, collected: null }),
  },
  {
    show: "worker: publish",
    by: "worker",
    can: (s) => s.status === ST_CLAIMED,
    go: (s) => ({ ...s, status: ST_PENDING, op: OP, ticket: s.gen }),
  },
  {
    show: "host: take",
    by: "host",
    can: (s) => s.status === ST_PENDING,
    // Compare-and-exchange, so a cancel that lands between the sweep and here wins.
    go: (s) => ({ ...s, status: ST_RUNNING, hostWorking: true }),
  },
  {
    show: "host: answer",
    by: "host",
    can: (s) => s.hostWorking,
    // The host only publishes into a slot it still owns: a cancel moved the status, and writing anyway
    // would overwrite `ST_CANCELLED` with `ST_READY` and strand the slot.
    go: (s) =>
      s.status === ST_RUNNING
        ? { ...s, status: ST_READY, answer: ANSWER, hostWorking: false }
        : { ...s, hostWorking: false },
  },
  {
    show: "host: reclaim cancelled",
    by: "host",
    can: (s) => s.status === ST_CANCELLED && !s.hostWorking,
    go: (s) => ({ ...s, status: ST_FREE, op: null, answer: null }),
  },
  {
    show: "worker: collect",
    by: "worker",
    can: (s) => s.ticket !== null && s.status === ST_READY && s.gen === s.ticket,
    go: (s) => ({
      ...s,
      collected: s.answer,
      status: ST_FREE,
      gen: s.gen + 1,
      ticket: null,
      op: null,
      answer: null,
    }),
  },
  {
    show: "worker: cancel",
    by: "worker",
    can: (s) => s.ticket !== null && s.gen === s.ticket && s.status !== ST_FREE,
    go: (s) =>
      s.status === ST_READY
        // Already answered: collecting and discarding is what `cancel` does, so the slot comes straight
        // back rather than waiting for a host that has nothing left to do.
        ? { ...s, status: ST_FREE, gen: s.gen + 1, ticket: null, op: null, answer: null }
        : { ...s, status: ST_CANCELLED, gen: s.gen + 1, ticket: null },
  },
];

type Broken = { rule: string; path: string[]; detail: string };

/** Walk every interleaving of the two agents' moves to `depth`. */
function enumerate(depth: number, moves: readonly Move[]): Broken[] {
  const broken: Broken[] = [];

  const walk = (s: Slot, path: string[]): void => {
    if (path.length === depth || broken.length > 0) return;
    for (const m of moves) {
      if (!m.can(s)) continue;
      const after = m.go(s);
      const here = [...path, m.show];
      const fail = (rule: string, detail: string) => broken.push({ rule, path: here, detail });

      // The answer a worker collects is the answer to the call it made — never a later call's, which is
      // what the generation exists to prevent and what would look entirely plausible if it happened.
      if (after.collected !== null && after.collected !== ANSWER) {
        fail("the worker collected something that was not its answer", `${after.collected}`);
        return;
      }
      // A slot the host is working on cannot be handed to anyone else.
      if (after.hostWorking && after.status === ST_FREE) {
        fail("a slot was freed while the host was still working on it", "");
        return;
      }
      // Nobody owns it: not free, not held by a live ticket, and the host is not working on it. That is
      // the ring losing a slot for good — four of those and it cannot be used at all.
      // Who will move this slot next? Exactly one of:
      //
      //   - it is free, so the next claim will;
      //   - it is claimed, and the worker is mid-fill — no ticket exists yet;
      //   - a live ticket holds it, so the worker will collect or cancel;
      //   - the host is inside the handler, so it will answer;
      //   - it is cancelled, and the host reclaims those.
      //
      // Anything else is stranded, and the two cases that matter are precise: a slot left **ready with no
      // live ticket** is an answer nobody will ever collect, and a slot left **running with nobody
      // working** is a request nobody will ever finish. Writing this as "READY counts as owned" — which
      // is how it went in first — let the plain-store mutant through, because that bug's whole signature
      // is an answer written into a slot whose ticket had already died.
      const owned = after.status === ST_FREE || after.status === ST_CLAIMED ||
        after.status === ST_CANCELLED || after.ticket !== null || after.hostWorking;
      if (!owned) {
        fail("a slot ended up owned by nobody", `status ${after.status}, ticket ${after.ticket}`);
        return;
      }
      // A pending slot always carries the opcode of the request in it — never the previous call's.
      if (after.status === ST_PENDING && after.op === null) {
        fail("a slot was published with no opcode in it", "the `no handler for capability 0` shape");
        return;
      }
      walk(after, here);
    }
  };

  walk(fresh(), []);
  return broken;
}

Deno.test("every interleaving of one slot leaves it owned and its answers matched", () => {
  const broken = enumerate(9, MOVES);
  assertEquals(
    broken.length === 0,
    true,
    broken.length === 0
      ? ""
      : `${broken[0].rule}\n  path: ${broken[0].path.join(" → ")}\n  ${broken[0].detail}`,
  );
});

Deno.test("a slot always comes back: no interleaving strands one for good", () => {
  // Liveness, as far as a bounded walk can speak to it: from every reachable state there is *some*
  // continuation that returns the slot to free. A state with no way home is a slot the ring has lost —
  // which is what the plain-store bug did, permanently, one slot per occurrence.
  const seen = new Set<string>();
  const key = (s: Slot) => `${s.status}|${s.gen === s.ticket}|${s.ticket !== null}|${s.hostWorking}`;
  const reachable: Slot[] = [];

  const explore = (s: Slot, depth: number): void => {
    const k = key(s);
    if (seen.has(k) || depth === 0) return;
    seen.add(k);
    reachable.push(s);
    for (const m of MOVES) if (m.can(s)) explore(m.go(s), depth - 1);
  };
  explore(fresh(), 9);

  const stuck = reachable.filter((s) => {
    // Can this state reach `ST_FREE` at all?
    const visited = new Set<string>();
    const canReachFree = (t: Slot, depth: number): boolean => {
      if (t.status === ST_FREE) return true;
      if (depth === 0) return false;
      const tk = key(t);
      if (visited.has(tk)) return false;
      visited.add(tk);
      return MOVES.some((m) => m.can(t) && canReachFree(m.go(t), depth - 1));
    };
    return !canReachFree(s, 8);
  });

  assertEquals(
    stuck.length,
    0,
    `${stuck.length} state(s) can never return the slot: ${stuck.map(key).join(", ")}`,
  );
  console.log(`  ${reachable.length} distinct slot states reachable, all of them returnable`);
});

Deno.test("the invariants catch the plain-store bug the fuzzer found", () => {
  // The historical bug: the host takes a pending slot with a *store* rather than a compare-and-exchange,
  // so a cancel landing between the sweep and the take is overwritten. The worker believes the call is
  // cancelled and will not collect; the sweep never sees a cancelled slot to hand back. The slot is owned
  // by nobody, for the life of the program.
  const withPlainStore: readonly Move[] = MOVES.map((m) =>
    m.show === "host: take"
      ? { ...m, can: (s: Slot) => s.status === ST_PENDING || s.status === ST_CANCELLED,
          go: (s: Slot) => ({ ...s, status: ST_RUNNING, hostWorking: true }) }
      : m
  );
  const broken = enumerate(9, withPlainStore);
  assertEquals(broken.length > 0, true, "a slot stranded by a plain store went unnoticed");
  console.log(`  stranded by: ${broken[0].path.join(" → ")}`);
});

Deno.test("and a publish that skips `claimed`, which is the other historical one", () => {
  // One state for "taken" and "has a request in it" together: the sweep dispatches a slot whose opcode
  // has not been written, and the host runs whatever the previous call left there — zero on a slot's
  // first use, hence `no handler for capability 0`.
  const eager: readonly Move[] = MOVES.map((m) =>
    m.show === "worker: claim"
      ? {
        ...m,
        go: (s: Slot) => ({ ...s, status: ST_PENDING, op: null, answer: null, collected: null, ticket: s.gen }),
      }
      : m
  );
  const broken = enumerate(6, eager);
  assertEquals(broken.length > 0, true, "a slot published with no opcode went unnoticed");
  assertEquals(
    broken[0].rule,
    "a slot was published with no opcode in it",
    `caught the wrong thing: ${broken[0].rule}`,
  );
});
