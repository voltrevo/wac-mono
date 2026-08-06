// A child's stream, as a state machine and a thin driver of it.
//
// This is the queue behind every pipe in the system: a spawned program's standard output, its standard
// error, and the input its parent feeds it. It carries bytes, it bounds how many it will hold, and it
// parks a writer whose reader is behind — which is what makes `seq 1 2000000000 > out` write the whole
// file rather than the two per cent it wrote when a full queue was reported as a closed one.
//
// ## Why the semantics are separated from the scheduling
//
// Whether `push` hands bytes straight to a waiting reader or buffers them, whether `end` lands before or
// after a `next` registers, whether a writer parks — all of that depends on how two sides interleave, and
// the interleaving is decided by a real event loop. So the same script takes different paths from run to
// run, and a rule that is wrong in one of them shows up as a test that fails once in fifty runs on an idle
// machine. That is how wac-mono 0078 lived here: a zero-length write handed to a *waiting* reader read as
// the end of the stream, so `echo one; true; echo two` printed `one` alone — but only when the reader
// happened to be waiting at that moment.
//
// `apply` below is the whole of the queue's behaviour as a pure function: `(state, event) → (state,
// effects)`. Nothing in it awaits, resolves, or schedules. `ByteQueue` is a driver that turns promises
// into events and effects back into resolutions, and holds no rules of its own.
//
// The point is not tidiness. It means every interleaving can be *enumerated* — see
// `packages/platform/test/queue_model.test.ts`, which walks every sequence of pushes, reads, ends and
// cap-driven parks up to a bounded depth and checks the invariants on all of them, in a second. Under a
// real scheduler those same paths are sampled by luck.
//
// **What this does not cover**, said plainly: it is a model of the *protocol*, not of memory. A torn read
// on the SharedArrayBuffer, or a plain load where an `Atomics` one belongs, is invisible here and is only
// ever caught by the real thing under stress.

import { CHUNK } from "./layout.ts";

/** A parked writer: the bytes it is trying to send, and who to tell when it is decided. */
export type Parked = { readonly id: number; readonly bytes: Uint8Array };

/**
 * Everything the queue knows.
 *
 * `reader` is at most one on purpose: two concurrent reads of one stream are a program bug rather than
 * something to arbitrate, since the second would get bytes the first asked for. The earlier one is
 * released empty instead of being lost.
 */
export type QueueState = {
  readonly cap: number;
  readonly chunks: readonly Uint8Array[];
  readonly held: number;
  readonly ended: boolean;
  readonly reader: number | null;
  readonly writers: readonly Parked[];
};

export type Event =
  | { readonly kind: "push"; readonly id: number; readonly bytes: Uint8Array }
  | { readonly kind: "next"; readonly id: number; readonly limit: number }
  | { readonly kind: "end" }
  | { readonly kind: "endWith"; readonly bytes: Uint8Array };

/** What the driver has to do once the state has moved. Never more than one per waiting party. */
export type Effect =
  | { readonly to: "writer"; readonly id: number; readonly ok: boolean }
  | { readonly to: "reader"; readonly id: number; readonly bytes: Uint8Array };

export type Step = { readonly state: QueueState; readonly effects: readonly Effect[] };

const EMPTY = new Uint8Array(0);

export function emptyQueue(cap = 0): QueueState {
  return { cap, chunks: [], held: 0, ended: false, reader: null, writers: [] };
}

function join(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Hand queued bytes to the writers waiting for room, in the order they arrived.
 *
 * In arrival order because a stream is ordered: releasing the smallest first would interleave one
 * producer's output with another's. A writer that still does not fit stops the line — the ones behind it
 * wait too, which is what keeps a single producer's bytes in sequence.
 */
function releaseRoom(state: QueueState): Step {
  const chunks = [...state.chunks];
  const writers = [...state.writers];
  const effects: Effect[] = [];
  let held = state.held;
  while (writers.length > 0) {
    const first = writers[0];
    if (state.cap > 0 && held + first.bytes.length > state.cap) break;
    writers.shift();
    chunks.push(first.bytes);
    held += first.bytes.length;
    effects.push({ to: "writer", id: first.id, ok: true });
  }
  return { state: { ...state, chunks, held, writers }, effects };
}

/** Up to `limit` bytes of what is queued, or null when nothing is. Splits a chunk rather than reordering. */
function take(state: QueueState, limit: number): { state: QueueState; taken: Uint8Array | null } {
  if (state.chunks.length === 0) return { state, taken: null };
  const chunks = [...state.chunks];
  const parts: Uint8Array[] = [];
  let got = 0;
  while (chunks.length > 0 && got < limit) {
    const head = chunks[0];
    if (got + head.length <= limit) {
      chunks.shift();
      parts.push(head);
      got += head.length;
    } else {
      const room = limit - got;
      parts.push(head.subarray(0, room));
      chunks[0] = head.subarray(room);
      got += room;
    }
  }
  return { state: { ...state, chunks, held: state.held - got }, taken: join(parts) };
}

/**
 * The queue's entire behaviour: one event in, a new state and what to tell whom.
 *
 * Pure — no promises, no timers, no clock. Everything that made this hard to test lives in the driver
 * below, and everything that made it *wrong* lives here where it can be enumerated.
 */
export function apply(state: QueueState, event: Event): Step {
  switch (event.kind) {
    case "push": {
      // A closed stream refuses, and that is how a producer learns its reader has gone rather than is
      // merely behind — the distinction `write` in `platform.wac` reports as false.
      if (state.ended) return { state, effects: [{ to: "writer", id: event.id, ok: false }] };
      // **A zero-length write is a no-op, not a stream.** Empty is this queue's end sentinel, so handing
      // an empty array to a waiting reader would end the stream from its point of view and discard
      // everything after it. `packages/sh`'s `true` returns no bytes, and `echo one; true; echo two`
      // printed `one` alone through a spawned shell until this line existed. wac-mono 0078.
      if (event.bytes.length === 0) return { state, effects: [{ to: "writer", id: event.id, ok: true }] };
      // Straight to a waiter if there is one, so nothing is buffered that is already wanted. The cap is
      // not consulted: bytes that are being handed over are not being held.
      if (state.reader !== null) {
        return {
          state: { ...state, reader: null },
          effects: [
            { to: "reader", id: state.reader, bytes: event.bytes },
            { to: "writer", id: event.id, ok: true },
          ],
        };
      }
      if (state.cap > 0 && state.held + event.bytes.length > state.cap) {
        // Parked, not refused. **Full and gone are different answers**: refusing here tells a producer
        // written to stop on false that its reader has gone, and `seq 1 2000000000 > out` then wrote
        // 276 MB, exited 0, and left a file two per cent of the size bash writes.
        return { state: { ...state, writers: [...state.writers, { id: event.id, bytes: event.bytes }] }, effects: [] };
      }
      return {
        state: { ...state, chunks: [...state.chunks, event.bytes], held: state.held + event.bytes.length },
        effects: [{ to: "writer", id: event.id, ok: true }],
      };
    }

    case "next": {
      const got = take(state, event.limit);
      if (got.taken !== null) {
        // Taking made room, so whoever was parked for it may go.
        const freed = releaseRoom(got.state);
        return {
          state: freed.state,
          effects: [{ to: "reader", id: event.id, bytes: got.taken }, ...freed.effects],
        };
      }
      if (state.ended) return { state, effects: [{ to: "reader", id: event.id, bytes: EMPTY }] };
      // One reader at a time; the earlier one is released empty rather than being forgotten.
      const displaced: Effect[] = state.reader === null
        ? []
        : [{ to: "reader", id: state.reader, bytes: EMPTY }];
      return { state: { ...state, reader: event.id }, effects: displaced };
    }

    case "end": {
      const effects: Effect[] = [];
      if (state.reader !== null) effects.push({ to: "reader", id: state.reader, bytes: EMPTY });
      for (const w of state.writers) effects.push({ to: "writer", id: w.id, ok: false });
      return { state: { ...state, ended: true, reader: null, writers: [] }, effects };
    }

    case "endWith": {
      // One last thing, then the end — a diagnostic about the stream itself. Not `push` then `end`: a
      // full queue *parks* a writer and `end` refuses the parked ones, so a last line pushed onto a full
      // queue would be dropped by the very call meant to follow it. The cap it bypasses is not
      // protecting anything from one host-written line.
      if (state.ended) return apply(state, { kind: "end" });
      if (state.reader !== null) {
        const handed: QueueState = { ...state, reader: null };
        const closed = apply(handed, { kind: "end" });
        return {
          state: closed.state,
          effects: [{ to: "reader", id: state.reader, bytes: event.bytes }, ...closed.effects],
        };
      }
      const held: QueueState = {
        ...state,
        chunks: [...state.chunks, event.bytes],
        held: state.held + event.bytes.length,
      };
      return apply(held, { kind: "end" });
    }
  }
}

/**
 * The driver: promises in, events out, effects back to whoever is waiting.
 *
 * Holds no rules. Everything it does is `apply` plus bookkeeping of who to resolve, which is what makes
 * the model above worth having — a rule that exists only here would be a rule nothing can enumerate.
 */
export class ByteQueue {
  #state: QueueState;
  #readers = new Map<number, (v: Uint8Array) => void>();
  #writers = new Map<number, (ok: boolean) => void>();
  #next = 0;

  constructor(cap = 0) {
    this.#state = emptyQueue(cap);
  }

  #run(event: Event): void {
    const step = apply(this.#state, event);
    this.#state = step.state;
    for (const e of step.effects) {
      if (e.to === "reader") {
        const res = this.#readers.get(e.id);
        this.#readers.delete(e.id);
        res?.(e.bytes);
      } else {
        const res = this.#writers.get(e.id);
        this.#writers.delete(e.id);
        res?.(e.ok);
      }
    }
  }

  /**
   * Take these bytes, waiting for room if the queue is full, and answering false once it has ended.
   *
   * A real pipe blocks a writer whose reader is behind and fails one whose reader has gone; this does the
   * same. The child is parked in `Atomics.wait` on its own `write` call meanwhile, which is exactly the
   * shape a blocking write has on the other side of a bridge.
   */
  push(b: Uint8Array): Promise<boolean> {
    const id = this.#next++;
    return new Promise<boolean>((res) => {
      this.#writers.set(id, res);
      this.#run({ kind: "push", id, bytes: b });
    });
  }

  /**
   * The next chunk, or empty once ended and drained.
   *
   * **Everything queued, up to `CHUNK`** — not literally the next thing pushed. A writer emitting a line
   * at a time and a reader across a bridge is one round trip per line otherwise: `seq 1 200000 | wc -l`
   * took forty-five seconds that way, almost all of it in parks and wakes. Coalescing is legal by the
   * protocol, which promises *at most* `CHUNK` bytes.
   */
  next(): Promise<Uint8Array> {
    const id = this.#next++;
    return new Promise<Uint8Array>((res) => {
      this.#readers.set(id, res);
      this.#run({ kind: "next", id, limit: CHUNK });
    });
  }

  /**
   * Everything, to the end — for `readStdin`, which promises exactly that.
   *
   * A child's standard input arrives over time, so "all of it" means waiting for the end rather than
   * taking what is there. Serving `readStdin` with one chunk is the bug this exists to avoid:
   * `seq 1 5 | sort -r` printed `1`, because `sort` reads to the end before sorting and the end came
   * after one line.
   */
  async rest(): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for (;;) {
      const c = await this.next();
      if (c.length === 0) return join(parts);
      parts.push(c);
    }
  }

  /** No more will arrive: a waiting reader gets the end, and a parked writer is refused. */
  end(): void {
    this.#run({ kind: "end" });
  }

  /** One last thing, then the end — see `apply`'s `endWith` for why it is not push-then-end. */
  endWith(b: Uint8Array): void {
    this.#run({ kind: "endWith", bytes: b });
  }

  /** What the queue is holding, for a caller narrating a stall. Reads nothing into the state. */
  describe(): string {
    const s = this.#state;
    return `${s.chunks.length} chunk(s) ${s.held}b${s.ended ? " ended" : ""}` +
      `${s.reader === null ? "" : " reader-waiting"}${s.writers.length > 0 ? ` ${s.writers.length} writer(s) parked` : ""}`;
  }
}
