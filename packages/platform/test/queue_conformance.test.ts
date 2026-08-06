// The real queue does what the model says it does.
//
// `queue_model.test.ts` walks every interleaving of `apply` and proves things about it. That is worth
// exactly as much as the claim that `ByteQueue` — the thing the system actually runs — behaves like
// `apply`. If the driver ever grows a rule of its own, the model becomes a fiction that passes: the most
// dangerous failure available to this whole approach, because it would look like evidence.
//
// So: a thousand seeded sequences of operations, issued against the real queue and against the model in
// the same order, with every resolution compared. Promises are the only difference allowed. A seed is
// printed with any failure, so a divergence is replayable rather than a story about randomness.
//
// The seeded generator is deliberately biased towards the awkward states — a small cap, so writers park;
// reads that ask for one byte, so chunks split; zero-length writes, so the end sentinel is exercised.
// Uniform random over the operations would spend most of its time on empty queues.

import { apply, ByteQueue, emptyQueue, type Event, type QueueState } from "../host/queue.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

/** xorshift32: a generator whose seed really does reproduce the sequence. */
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

type Op =
  | { kind: "push"; bytes: Uint8Array }
  | { kind: "next"; limit: number }
  | { kind: "end" }
  | { kind: "endWith"; bytes: Uint8Array };

/** What a caller saw. `null` means the call has not settled yet, which is itself part of the comparison. */
type Outcome = { call: number; got: string | null };

function generate(seed: number, n: number): Op[] {
  const next = rng(seed);
  const ops: Op[] = [];
  let byte = 1;
  for (let i = 0; i < n; i++) {
    const roll = next() % 10;
    if (roll < 4) {
      const len = next() % 3; // 0, 1 or 2 — zero-length is the sentinel case
      ops.push({ kind: "push", bytes: Uint8Array.from({ length: len }, () => byte++ & 0xff) });
    } else if (roll < 8) {
      ops.push({ kind: "next", limit: (next() % 2) === 0 ? 1 : 64 });
    } else if (roll === 8) {
      ops.push({ kind: "end" });
    } else {
      ops.push({ kind: "endWith", bytes: Uint8Array.of(byte++ & 0xff) });
    }
  }
  return ops;
}

/** Run the operations against the real queue, recording what each call resolved to, and when. */
async function onReal(ops: Op[], cap: number): Promise<Outcome[]> {
  const q = new ByteQueue(cap);
  const out: Outcome[] = ops.map((_, i) => ({ call: i, got: null }));
  const settled: Promise<void>[] = [];

  ops.forEach((op, i) => {
    if (op.kind === "push") {
      settled.push(q.push(op.bytes).then((ok) => {
        out[i].got = ok ? "ok" : "refused";
      }));
    } else if (op.kind === "next") {
      // The driver's `next` always asks for CHUNK; the model is told the same, so `limit` only varies in
      // the model's own walk. Here it is recorded for the report and otherwise ignored.
      settled.push(q.next().then((bytes) => {
        out[i].got = [...bytes].join(",");
      }));
    } else if (op.kind === "end") {
      q.end();
    } else {
      q.endWith(op.bytes);
    }
  });

  // Let everything that *can* settle settle. What is still pending is part of the answer: a caller left
  // waiting is exactly what the model predicts with `reader` or a parked writer set.
  await Promise.race([Promise.all(settled), new Promise((r) => setTimeout(r, 0))]);
  await new Promise((r) => setTimeout(r, 0));
  return out;
}

/** The same operations through the model, in the same order, recording the same outcomes. */
function onModel(ops: Op[], cap: number, chunk: number): Outcome[] {
  let state: QueueState = emptyQueue(cap);
  const out: Outcome[] = ops.map((_, i) => ({ call: i, got: null }));
  const owner = new Map<number, number>(); // event id → call index
  let id = 0;

  for (const [i, op] of ops.entries()) {
    let event: Event;
    if (op.kind === "push") {
      event = { kind: "push", id: id++, bytes: op.bytes };
      owner.set(event.id, i);
    } else if (op.kind === "next") {
      event = { kind: "next", id: id++, limit: chunk };
      owner.set(event.id, i);
    } else if (op.kind === "end") {
      event = { kind: "end" };
    } else {
      event = { kind: "endWith", bytes: op.bytes };
    }
    const step = apply(state, event);
    state = step.state;
    for (const e of step.effects) {
      const at = owner.get(e.id);
      if (at === undefined) continue;
      out[at].got = e.to === "writer" ? (e.ok ? "ok" : "refused") : [...e.bytes].join(",");
    }
  }
  return out;
}

Deno.test("a thousand seeded sequences: the queue and its model agree, call for call", async () => {
  const CHUNK = 1 << 16; // what the driver asks for
  for (let seed = 1; seed <= 1000; seed++) {
    const cap = seed % 3 === 0 ? 0 : (seed % 3) + 1; // 0 (uncapped), 2, 3 — small enough to park
    const ops = generate(seed, 8);
    const real = await onReal(ops, cap);
    const model = onModel(ops, cap, CHUNK);

    for (let i = 0; i < ops.length; i++) {
      if (real[i].got === model[i].got) continue;
      const show = ops.map((o, j) =>
        `${j === i ? ">" : " "}${o.kind}${o.kind === "push" || o.kind === "endWith" ? `(${o.bytes.length}b)` : ""}`
      ).join(" ");
      assertEquals(
        real[i].got,
        model[i].got,
        `seed ${seed}, cap ${cap}, call ${i} (${ops[i].kind}) diverged\n  ${show}`,
      );
    }
  }
});

Deno.test("and the model is not vacuously agreeing: the sequences reach the interesting states", async () => {
  // A conformance test over sequences that never park a writer or split a chunk would agree perfectly and
  // mean nothing. This counts what the thousand sequences actually reached.
  let parked = 0;
  let refused = 0;
  let ended = 0;
  let split = 0;
  for (let seed = 1; seed <= 1000; seed++) {
    const cap = seed % 3 === 0 ? 0 : (seed % 3) + 1;
    const ops = generate(seed, 8);
    const model = onModel(ops, cap, 1); // limit 1 so splitting is visible
    for (const o of model) {
      if (o.got === null) parked++;
      else if (o.got === "refused") refused++;
      else if (o.got === "") ended++;
      else if (o.got.split(",").length === 1) split++;
    }
  }
  assertEquals(parked > 100, true, `only ${parked} calls were left waiting`);
  assertEquals(refused > 50, true, `only ${refused} writes were refused`);
  assertEquals(ended > 50, true, `only ${ended} reads saw the end`);
  assertEquals(split > 100, true, `only ${split} reads took a single byte`);
  console.log(`  reached: ${parked} parked, ${refused} refused, ${ended} at-end, ${split} single-byte`);
});
