// Every interleaving of a stream's events, and the rules that must hold in all of them.
//
// The queue behind every pipe here is used by two sides that are scheduled independently: a child writing
// and a parent reading, or the reverse. Which of them acts next is decided by a real event loop, so a run
// visits *one* interleaving and the next run may visit another. A rule that is wrong in one path shows up
// as a test that fails once in fifty runs on a machine that happens to be idle — which is exactly how
// wac-mono 0078 lived here, and how 0082's wedge still does.
//
// `apply` in `host/queue.ts` is the queue's behaviour as a pure function, so the interleavings can be
// *enumerated* instead of sampled: every sequence of pushes, reads, ends and cap-driven parks up to a
// bounded depth, in about a second. What follows is the invariant set that every reachable state and every
// effect must satisfy.
//
// **The invariants are the interesting part, not the enumeration.** Each one is a bug this repo has
// already had, or a hang it could have:
//
//   - a reader resolved empty when the stream has not ended and nothing displaced it — that *is* 0078,
//     where `true` writing zero bytes ended the stream from the reader's point of view;
//   - a reader parked with bytes queued — a lost wakeup, the shape of 0082's wedge one layer up;
//   - a writer parked with room for it — a producer that will never be told it may continue;
//   - bytes delivered out of order, duplicated, or dropped while the writer was told `ok`.
//
// The last test is the one that keeps this honest: it re-introduces 0078 into the model and requires the
// enumeration to *fail*. An invariant set that passes a known bug is decoration.

import { apply, type Effect, emptyQueue, type Event, type QueueState } from "../host/queue.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

type Transition = (state: QueueState, event: Event) => { state: QueueState; effects: readonly Effect[] };

/** A violation, named so the failure says which rule and which path. */
type Broken = { rule: string; path: string[]; detail: string };

/**
 * Walk every sequence of events up to `depth`, checking the invariants at each step.
 *
 * **Every event gets a fresh id and fresh byte values**, which the first version did not: reusing a
 * reader's id made a reader displacing *itself* look like the stream ending early, and reusing byte
 * values made "was this byte delivered twice?" unanswerable. The driver hands out a new id per call, so
 * this is also what the real thing does.
 */
function enumerate(cap: number, depth: number, step: Transition): Broken[] {
  const broken: Broken[] = [];

  /**
   * The alphabet, as shapes. Identities are allocated **per path**, not globally: a byte value only has
   * to be unique among the bytes alive in *this* interleaving, and a global counter wrapped at 256 —
   * about nineteen thousand nodes into the walk — which the "a byte was delivered twice" invariant duly
   * reported as a bug in the queue. It was a bug in the test.
   */
  const SHAPES: ReadonlyArray<{ show: string; make: (n: Alloc) => Event }> = [
    { show: "push(1b)", make: (n) => ({ kind: "push", id: n.id(), bytes: Uint8Array.of(n.byte()) }) },
    { show: "push(2b)", make: (n) => ({ kind: "push", id: n.id(), bytes: Uint8Array.of(n.byte(), n.byte()) }) },
    { show: "push(0b)", make: (n) => ({ kind: "push", id: n.id(), bytes: new Uint8Array(0) }) },
    { show: "next(≤1)", make: (n) => ({ kind: "next", id: n.id(), limit: 1 }) },
    { show: "next(≤64)", make: (n) => ({ kind: "next", id: n.id(), limit: 64 }) },
    { show: "end", make: (): Event => ({ kind: "end" }) },
    { show: "endWith(1b)", make: (n): Event => ({ kind: "endWith", bytes: Uint8Array.of(n.byte()) }) },
  ];

  type Alloc = { id(): number; byte(): number };
  type Trace = {
    /** Bytes each accepted push contributed, in the order it wrote them. */
    accepted: Map<number, number[]>;
    /** Everything handed to readers, in the order it was handed over. */
    delivered: number[];
  };

  const walk = (state: QueueState, path: string[], trace: Trace, used: { ids: number; bytes: number }): void => {
    if (path.length === depth || broken.length > 0) return;
    for (const shape of SHAPES) {
      const mine = { ids: used.ids, bytes: used.bytes };
      const alloc: Alloc = { id: () => mine.ids++, byte: () => mine.bytes++ };
      const event = shape.make(alloc);
      const { state: after, effects } = step(state, event);
      const here = [...path, shape.show];
      const accepted = new Map(trace.accepted);
      const delivered = [...trace.delivered];
      let failed = false;
      const fail = (rule: string, detail: string) => {
        broken.push({ rule, path: here, detail });
        failed = true;
      };

      for (const e of effects) {
        if (e.to === "writer") {
          if (!e.ok) continue;
          if (event.kind === "push" && e.id === event.id) {
            accepted.set(e.id, [...event.bytes]);
          } else {
            // A parked writer released by a read: its bytes have just entered the stream.
            const parked = state.writers.find((w) => w.id === e.id);
            if (parked !== undefined) accepted.set(e.id, [...parked.bytes]);
          }
          continue;
        }
        if (e.bytes.length === 0) {
          // Empty means the end. Legal only if the stream has ended, or if this reader was displaced by
          // a newer one — which can only happen on a `next` by somebody else. 0078 is what this catches.
          const displaced = event.kind === "next" && e.id !== event.id;
          if (!after.ended && !displaced) {
            fail("a reader was told the stream ended when it had not", `reader #${e.id} got 0 bytes`);
            return;
          }
        }
        delivered.push(...e.bytes);
      }
      if (failed) return;

      // ── The state's own rules ────────────────────────────────────────────
      if (after.reader !== null && after.chunks.length > 0) {
        fail("a reader is parked with bytes queued", `${after.chunks.length} chunk(s) held`);
        return;
      }
      // Only the *head* of the parked writers: the ones behind it wait on purpose, because releasing a
      // small write past a large one would interleave two producers' bytes. That distinction is why this
      // reads `writers[0]` and not `writers.find(…)`, which is how it was written first — and it reported
      // the queue as broken for doing the right thing.
      const head = after.writers[0];
      if (head !== undefined && (after.cap === 0 || after.held + head.bytes.length <= after.cap)) {
        fail("the first parked writer has room and was not released", `${after.held}/${after.cap} held`);
        return;
      }
      if (after.ended && (after.writers.length > 0 || after.reader !== null)) {
        fail("the stream ended with somebody still waiting on it", `${after.writers.length} writer(s)`);
        return;
      }
      const sum = after.chunks.reduce((n, c) => n + c.length, 0);
      if (after.held !== sum) {
        fail("held bytes do not match the chunks", `${after.held} against ${sum}`);
        return;
      }

      // ── Nothing accepted is lost, duplicated or reordered ────────────────
      const queued = after.chunks.flatMap((c) => [...c]);
      const stream = [...delivered, ...queued];
      if (new Set(stream).size !== stream.length) {
        fail("a byte was delivered twice", stream.join(","));
        return;
      }
      for (const [id, bytes] of accepted) {
        const found = stream.filter((b) => bytes.includes(b));
        if (found.length !== bytes.length) {
          fail("bytes a writer was told were accepted went missing", `writer #${id}: ${bytes.join(",")}`);
          return;
        }
        if (found.join(",") !== bytes.join(",")) {
          fail("a writer's bytes were reordered", `writer #${id}: ${bytes.join(",")} became ${found.join(",")}`);
          return;
        }
      }

      walk(after, here, { accepted, delivered }, mine);
    }
  };

  walk(emptyQueue(cap), [], { accepted: new Map(), delivered: [] }, { ids: 0, bytes: 0 });
  return broken;
}

const show = (path: string[]): string => path.join(" → ");

Deno.test("every interleaving of a capped stream obeys the queue's rules", () => {
  // Cap 2 against payloads of 1 and 2 bytes, so parking, partial release and splitting are all reachable
  // within the depth. Depth 6 is 7^6 = 117,649 paths, each checked at every step, in about a fifth of a
  // second — deep enough to reach park → read → release → end, which five is not.
  const broken = enumerate(2, 6, apply);
  assertEquals(
    broken.length === 0,
    true,
    broken.length === 0 ? "" : `${broken[0].rule}\n  path: ${show(broken[0].path)}\n  ${broken[0].detail}`,
  );
});

Deno.test("and of an uncapped one, where a writer never parks", () => {
  const broken = enumerate(0, 6, apply);
  assertEquals(
    broken.length === 0,
    true,
    broken.length === 0 ? "" : `${broken[0].rule}\n  path: ${show(broken[0].path)}\n  ${broken[0].detail}`,
  );
});

Deno.test("the invariants catch 0078, which is why they are worth having", () => {
  // The historical bug, put back: a zero-length write handed straight to a *waiting* reader. It was
  // invisible under a scheduler — it needed a reader to be parked at that exact moment — and it printed
  // `one` where bash printed `one two`.
  //
  // If this enumeration passes, the invariant set is decoration and the two tests above prove nothing.
  const with0078: Transition = (state, event) => {
    if (event.kind === "push" && event.bytes.length === 0 && state.reader !== null && !state.ended) {
      return {
        state: { ...state, reader: null },
        effects: [
          { to: "reader", id: state.reader, bytes: new Uint8Array(0) },
          { to: "writer", id: event.id, ok: true },
        ],
      };
    }
    return apply(state, event);
  };

  const broken = enumerate(2, 5, with0078);
  assertEquals(broken.length > 0, true, "the enumeration accepted 0078 — the invariants are too weak");
  assertEquals(
    broken[0].rule,
    "a reader was told the stream ended when it had not",
    `caught the wrong thing: ${broken[0].rule}`,
  );
  // The path is the counter-example somebody would have had to find by hand, and by rediscovering it
  // this test also documents what it takes to hit it: a reader parked, then a zero-length write.
  console.log(`  0078 reproduced by: ${show(broken[0].path)}`);
});

Deno.test("a bug in the cap is caught too, so the set is not only about the sentinel", () => {
  // A second mutant, because one caught bug can be a coincidence. Here `end` forgets to refuse the
  // writers parked behind a full queue — they would wait for room that is never coming, which is a
  // producer hung on a stream nobody will ever read again.
  const forgetful: Transition = (state, event) => {
    if (event.kind === "end") {
      const effects: Effect[] = state.reader === null
        ? []
        : [{ to: "reader", id: state.reader, bytes: new Uint8Array(0) }];
      return { state: { ...state, ended: true, reader: null }, effects };
    }
    return apply(state, event);
  };

  const broken = enumerate(2, 5, forgetful);
  assertEquals(broken.length > 0, true, "a stream that ends with writers still parked went unnoticed");
  assertEquals(
    broken[0].rule,
    "the stream ended with somebody still waiting on it",
    `caught the wrong thing: ${broken[0].rule}`,
  );
});
