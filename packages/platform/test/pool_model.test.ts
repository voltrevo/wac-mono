// The buffer pool, walked rather than sampled.
//
// The fourth model, after the queue, the child's lifecycle and the slot protocol. It exists because the
// transport stopped giving every slot a buffer of its own: 128 slots × 128 KiB is 16 MiB per bridge, and a
// shell that spawns four applets pays it four times. Slots are now cheap control records and the payload
// buffers are pooled, with a small inline area per slot as the guarantee that an answer can *always* be
// written. That trade buys eight times the fan-in for the same memory and introduces exactly one new
// hazard: **a buffer is shared, so who owns it has to be right in every interleaving.**
//
// It is not a hypothetical hazard. The pool's first version stored "no buffer" as -1 in a field of shared
// memory, which starts as zeroes — so every slot nobody had touched claimed to hold buffer 0, and the
// first `release` of an untouched slot handed that buffer back while a live answer was still in it. Two
// slots pointed at one buffer and the worker read one call's answer out of another's:
//
//   asked as 15, answered as 24 in slot 7 gen 0
//
// The fuzzer found it on its first seed, which is luck — the same class of bug hid for weeks twice before
// (see `bridge_model.test.ts`). This walks the states instead, and both mutants below are that bug and its
// mirror image, so the invariants have to be load-bearing rather than decorative.
//
// **Reachable states, not paths.** Two slots and a shared buffer make the path space too large to
// enumerate to a useful depth, and paths are the wrong unit anyway: what matters is whether a bad *state*
// is reachable. So this is a breadth-first walk of every reachable state with a visited set, keeping the
// path that first reached each one so a violation still prints how to get there.
//
// **What it does not cover**, in the same terms as the other three: this is a model of ownership, not of
// memory. Whether the store that publishes a handle is visible before the store that publishes the status
// is a question about `Atomics` and hardware, and no model here can see it.

import { ST_CANCELLED, ST_CLAIMED, ST_FREE, ST_PENDING, ST_READY, ST_RUNNING } from "../host/layout.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

/** How many slots and how many pooled buffers. Two and one: enough for one slot to steal the other's. */
const SLOTS = 2;
const BUFS = 1;

/**
 * A slot, plus where its answer bytes are.
 *
 * `res` is the modelled handle: a buffer index, or `null` for "the answer is in my inline area". The real
 * field holds a one-based index so that zeroed memory means `null`; the first mutant below is what happens
 * when it does not.
 */
type Slot = {
  status: number;
  gen: number;
  ticket: number | null;
  hostWorking: boolean;
  /** The call the host is working on, or that owns the answer — `slot:gen`, so a reuse is a new identity. */
  call: string | null;
  /** Attached pooled buffer, or null for inline. */
  res: number | null;
  /** What the worker read, for the invariant that it is its own answer and not a plausible one. */
  collected: string | null;
};

type World = {
  slots: Slot[];
  /** Free flags, exactly as `acquireBuf` reads them. */
  free: boolean[];
  /** Which call's bytes are in each pooled buffer — the thing cross-talk corrupts. */
  content: (string | null)[];
  /** Each slot's inline area, same question. */
  inline: (string | null)[];
};

const fresh = (): World => ({
  slots: Array.from({ length: SLOTS }, () => ({
    status: ST_FREE,
    gen: 0,
    ticket: null,
    hostWorking: false,
    call: null,
    res: null,
    collected: null,
  })),
  free: Array.from({ length: BUFS }, () => true),
  content: Array.from({ length: BUFS }, () => null),
  inline: Array.from({ length: SLOTS }, () => null),
});

const clone = (w: World): World => ({
  slots: w.slots.map((s) => ({ ...s })),
  free: [...w.free],
  content: [...w.content],
  inline: [...w.inline],
});

/** How the code under test frees a buffer: idempotent for "none". */
type Rules = {
  /** Whether freeing a slot releases buffer 0 when nothing is attached — the zeroed-memory bug. */
  readonly zeroMeansBufZero: boolean;
  /** Whether an answer the host cannot publish releases its buffer, or drops it on the floor. */
  readonly releaseOnLostRace: boolean;
};

const SOUND: Rules = { zeroMeansBufZero: false, releaseOnLostRace: true };

/** Take a buffer, or null when they are all busy. Deterministic: the lowest free one, as in `acquireBuf`. */
function acquire(w: World): number | null {
  for (let i = 0; i < BUFS; i++) if (w.free[i]) return i;
  return null;
}

function releaseAttached(w: World, s: Slot, r: Rules): void {
  const bi = s.res ?? (r.zeroMeansBufZero ? 0 : null);
  s.res = null;
  if (bi !== null) w.free[bi] = true;
}

type Move = { readonly show: string; readonly go: (w: World) => void };

/** Every step either side can take, for one slot. */
function movesFor(i: number, r: Rules): Move[] {
  const at = (w: World) => w.slots[i];
  return [
    {
      show: `w${i}: claim`,
      go: (w) => {
        const s = at(w);
        if (s.status !== ST_FREE || s.ticket !== null) return;
        s.status = ST_CLAIMED;
        s.collected = null;
      },
    },
    {
      show: `w${i}: publish`,
      go: (w) => {
        const s = at(w);
        if (s.status !== ST_CLAIMED) return;
        s.status = ST_PENDING;
        s.ticket = s.gen;
        s.call = `${i}:${s.gen}`;
      },
    },
    {
      show: `h${i}: take`,
      go: (w) => {
        const s = at(w);
        if (s.status !== ST_PENDING) return;
        s.status = ST_RUNNING;
        s.hostWorking = true;
      },
    },
    {
      // An answer that fits inline, or one that did not get a pooled buffer. Always available, which is
      // the progress guarantee the pool is not allowed to take away.
      show: `h${i}: answer inline`,
      go: (w) => {
        const s = at(w);
        if (!s.hostWorking) return;
        s.hostWorking = false;
        if (s.status !== ST_RUNNING) return; // cancelled under us; the answer is for nobody
        w.inline[i] = s.call;
        s.res = null;
        s.status = ST_READY;
      },
    },
    {
      show: `h${i}: answer pooled`,
      go: (w) => {
        const s = at(w);
        if (!s.hostWorking) return;
        const bi = acquire(w);
        if (bi === null) return; // no buffer: the inline move is the one that can still run
        w.free[bi] = false;
        w.content[bi] = s.call;
        s.hostWorking = false;
        if (s.status !== ST_RUNNING) {
          // Lost the publish: the slot was cancelled between the ownership check and the exchange. The
          // buffer has to go back here, because the sweep that frees the slot will find nothing attached.
          if (r.releaseOnLostRace) w.free[bi] = true;
          return;
        }
        s.res = bi;
        s.status = ST_READY;
      },
    },
    {
      show: `h${i}: reclaim cancelled`,
      go: (w) => {
        const s = at(w);
        if (s.status !== ST_CANCELLED || s.hostWorking) return;
        releaseAttached(w, s, r);
        s.status = ST_FREE;
        s.call = null;
      },
    },
    {
      show: `w${i}: collect`,
      go: (w) => {
        const s = at(w);
        if (s.ticket === null || s.status !== ST_READY || s.gen !== s.ticket) return;
        s.collected = s.res === null ? w.inline[i] : w.content[s.res];
        releaseAttached(w, s, r);
        s.status = ST_FREE;
        s.gen += 1;
        s.ticket = null;
        s.call = null;
      },
    },
    {
      show: `w${i}: cancel`,
      go: (w) => {
        const s = at(w);
        if (s.ticket === null || s.gen !== s.ticket || s.status === ST_FREE) return;
        if (s.status === ST_READY) {
          // Answered already: the worker hands the slot back itself, and the buffer with it.
          releaseAttached(w, s, r);
          s.status = ST_FREE;
          s.call = null;
        } else {
          s.status = ST_CANCELLED;
        }
        s.gen += 1;
        s.ticket = null;
      },
    },
  ];
}

type Broken = { rule: string; path: string[]; detail: string };

/** What has to hold in every reachable state. */
function check(w: World, path: string[], broken: Broken[]): void {
  const fail = (rule: string, detail: string) => broken.push({ rule, path, detail });

  // The answer a worker reads is the answer to the call it made. This is the one the zeroed-memory bug
  // broke, and it broke it *quietly*: the bytes are real bytes from a real call.
  for (const s of w.slots) {
    if (s.collected !== null && s.collected !== `${w.slots.indexOf(s)}:${s.gen - 1}`) {
      fail("a worker collected another call's answer", `got ${s.collected}`);
      return;
    }
  }
  // No buffer is attached to two slots at once.
  for (let bi = 0; bi < BUFS; bi++) {
    const holders = w.slots.filter((s) => s.res === bi).length;
    if (holders > 1) {
      fail("one buffer, two slots", `buffer ${bi} attached ${holders} times`);
      return;
    }
    // And a buffer somebody holds is not also on the free list — the double free, stated directly.
    if (holders === 1 && w.free[bi]) {
      fail("a buffer is free and attached at the same time", `buffer ${bi}`);
      return;
    }
  }
  // At rest, nothing is held: no slot in use, no host work, so every buffer is back. A pool that loses one
  // per occurrence is a bridge that stalls an hour later with nothing to point at.
  const idle = w.slots.every((s) => s.status === ST_FREE && !s.hostWorking && s.res === null);
  if (idle && w.free.some((f) => !f)) {
    fail("the pool leaked", `free=${JSON.stringify(w.free)}`);
    return;
  }
}

/** Breadth-first over every reachable state, keeping the first path to each. */
function explore(r: Rules, limit = 200_000): Broken[] {
  const broken: Broken[] = [];
  const moves = [0, 1].flatMap((i) => movesFor(i, r));
  const start = fresh();
  const key = (w: World) => JSON.stringify(w);
  const seen = new Set<string>([key(start)]);
  let frontier: { w: World; path: string[] }[] = [{ w: start, path: [] }];

  while (frontier.length > 0 && broken.length === 0 && seen.size < limit) {
    const next: { w: World; path: string[] }[] = [];
    for (const { w, path } of frontier) {
      for (const m of moves) {
        const after = clone(w);
        m.go(after);
        const k = key(after);
        if (seen.has(k)) continue;
        seen.add(k);
        const here = [...path, m.show];
        check(after, here, broken);
        if (broken.length > 0) return broken;
        next.push({ w: after, path: here });
      }
    }
    frontier = next;
  }
  return broken;
}

Deno.test("no reachable state has two slots sharing a buffer, or a buffer lost", () => {
  const broken = explore(SOUND);
  assertEquals(
    broken.length === 0,
    true,
    broken.length === 0 ? "" : `${broken[0].rule}: ${broken[0].detail}\n  ${broken[0].path.join(" → ")}`,
  );
});

Deno.test("the invariants catch the zeroed-memory bug the fuzzer found", () => {
  // "No buffer" as -1 in memory that starts at zero: an untouched slot claims buffer 0 and frees it.
  //
  // The rule is asserted, not just that *something* broke, because the interesting claim is that the
  // *delivery* invariant catches this and not only the accounting one. With the accounting checks removed
  // it still fails, on the path the real bug took:
  //
  //   w0 publish → h0 take → h0 answer pooled → w1 publish → w1 cancel → h1 reclaim (frees buffer 0,
  //   which it never held) → w1 publish → h1 take → h1 answer pooled (buffer 0 again) → w0 collect
  //
  // and what w0 reads is call 1:1's bytes. That is `asked as 15, answered as 24`, thirteen moves deep.
  const broken = explore({ ...SOUND, zeroMeansBufZero: true });
  assertEquals(broken.length > 0, true, "a slot freeing a buffer it never held has to be caught");
  assertEquals(
    broken[0].rule === "a worker collected another call's answer" ||
      broken[0].rule === "a buffer is free and attached at the same time" ||
      broken[0].rule === "one buffer, two slots",
    true,
    `caught the wrong thing: ${broken[0].rule}`,
  );
});

Deno.test("and its mirror image: a buffer dropped when the publish loses the race", () => {
  // The host wrote into a pooled buffer, then found the slot cancelled. Returning without releasing it
  // leaks one buffer per losing race — eight of those and the bridge stops for good.
  const broken = explore({ ...SOUND, releaseOnLostRace: false });
  assertEquals(broken.length > 0, true, "a leaked buffer has to be caught");
});
