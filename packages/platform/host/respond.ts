// The main-thread side of the bridge: answer host calls without ever blocking.
//
// `Atomics.waitAsync` is the counterpart to the worker's `Atomics.wait` — it returns a
// promise rather than parking the thread, so the event loop keeps running and the
// asynchronous work a capability needs can actually happen. A main thread that blocked
// here would deadlock against the worker waiting on it.
//
// **The loop dispatches and does not await.** It used to `await` each handler before
// looking at the next request, which serialised everything regardless of what the
// transport could carry — and with a ring of slots that would have made the ring
// pointless. A slot is claimed, its handler started, and the loop goes straight back to
// watching. Completion writes the answer into that slot and bumps `DONE_SEQ`.
//
// Several of these may run at once, one per worker. Nothing here is global — which is also
// why each worker needs its *own* handler table: the capability worlds close over the
// current input, the current output and the socket map, and one table shared between two
// workers would hand one of them the other's socket.

import {
  type Bridge,
  DONE_SEQ,
  OP_CONTINUE,
  OP_PUSH,
  S_GEN,
  S_OP,
  S_REQ_LEN,
  S_RES_LEN,
  S_RES_STATUS,
  S_STATUS,
  SLOT_BUF,
  SLOTS,
  slotAt,
  ST_CANCELLED,
  ST_FREE,
  ST_PENDING,
  ST_READY,
  ST_RUNNING,
  STATUS_ACK,
  STATUS_ERR,
  STATUS_MORE,
  STATUS_OK,
  SUBMIT_SEQ,
} from "./layout.ts";
import { FAULT_OTHER, faultedBytes, faultOf } from "./faults.ts";

/** What a capability does with a request payload. May be async; that is the point. */
export type Handler = (payload: Uint8Array) => Uint8Array | Promise<Uint8Array>;

/** Capability implementations by opcode. */
export type Handlers = Record<number, Handler>;

const enc = new TextEncoder();
const EMPTY = new Uint8Array(0);

function joined(parts: Uint8Array[], last: Uint8Array): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0) + last.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  out.set(last, at);
  return out;
}

/**
 * Serve host calls until `stop()` is called or the signal aborts.
 *
 * A response larger than a slot is handed over in pieces: what fits goes now with
 * `STATUS_MORE`, and the rest waits for the worker's `OP_CONTINUE`. The remainder is held
 * here rather than in the worker so a caller that abandons a call cannot leak it.
 */
export function serveHostCalls(
  b: Bridge,
  handlers: Handlers,
  opts: { signal?: AbortSignal } = {},
): { stop(): void; done: Promise<void> } {
  let running = true;

  // Per-slot state kept between the pieces of one call.
  const pending: (Uint8Array | null)[] = new Array(SLOTS).fill(null);      // response tail
  const partial: Uint8Array[][] = Array.from({ length: SLOTS }, () => []); // request head

  const reply = (slot: number, status: number, body: Uint8Array): void => {
    const at = slotAt(slot);
    b.res(slot).set(body, 0);
    Atomics.store(b.ctrl, at + S_RES_LEN, body.length);
    Atomics.store(b.ctrl, at + S_RES_STATUS, status);

    // Published with a compare-and-exchange, for the same reason `take` takes with one, and it
    // is the last store rather than the first because it is what makes the rest visible.
    //
    // A cancel can land between the ownership check above and this line. A plain store then
    // overwrote `ST_CANCELLED` with `ST_READY`, and the slot was stranded: the worker's ticket
    // is dead so it will never collect, and the sweep only ever looks at pending and cancelled
    // slots, so it would never hand it back either. One slot gone for the life of the program,
    // per losing race. The mirror image of the `take` case, and the fuzzer found this one too —
    // at the eighth seed, where four seeds had passed.
    //
    // The payload is written before the exchange, which is safe rather than tidy: only the host
    // writes a response, and the worker reads one only after seeing `ST_READY`. So a losing
    // exchange leaves bytes in a buffer that the slot's next owner overwrites before publishing.
    if (Atomics.compareExchange(b.ctrl, at + S_STATUS, ST_RUNNING, ST_READY) !== ST_RUNNING) {
      return;   // no longer ours; the sweep hands the slot back
    }
    Atomics.add(b.ctrl, DONE_SEQ, 1);
    Atomics.notify(b.ctrl, DONE_SEQ);
  };

  /** Answer, splitting the body if it does not fit. */
  const send = (slot: number, body: Uint8Array): void => {
    if (body.length <= SLOT_BUF) {
      pending[slot] = null;
      reply(slot, STATUS_OK, body);
      return;
    }
    pending[slot] = body.subarray(SLOT_BUF);
    reply(slot, STATUS_MORE, body.subarray(0, SLOT_BUF));
  };

  /** A slot the worker gave up on: drop what we know and hand it back. */
  const abandon = (slot: number): void => {
    pending[slot] = null;
    partial[slot] = [];
    Atomics.store(b.ctrl, slotAt(slot) + S_STATUS, ST_FREE);
    Atomics.add(b.ctrl, DONE_SEQ, 1);
    Atomics.notify(b.ctrl, DONE_SEQ);
  };

  const take = (slot: number): void => {
    const at = slotAt(slot);
    // Whose call this is. A slot outlives the call in it: `cancel` bumps the generation and
    // the sweep hands the slot straight back, while the handler here is still running. When
    // it finishes, the slot may belong to somebody else, and the answer has to be dropped
    // rather than written — see `stillOurs`.
    const gen = Atomics.load(b.ctrl, at + S_GEN);
    const op = Atomics.load(b.ctrl, at + S_OP);
    const len = Atomics.load(b.ctrl, at + S_REQ_LEN);
    const payload = b.req(slot).slice(0, len);

    // Taken with a compare-and-exchange, not a store.
    //
    // The sweep saw `ST_PENDING` a moment ago and the worker may have cancelled since. A plain
    // store would overwrite `ST_CANCELLED` with `ST_RUNNING`, and then nobody owns the slot:
    // the worker believes it is cancelled and will not collect, the sweep never sees a
    // cancelled slot to hand back, and the answer is dropped because the generation moved. The
    // slot stays `RUNNING` for the life of the program — one fewer for good, and four of those
    // is a ring that cannot be used. Found by `fuzz.test.ts` on its first run, in the
    // end-of-run check that every slot came back free.
    if (
      Atomics.compareExchange(b.ctrl, at + S_STATUS, ST_PENDING, ST_RUNNING) !== ST_PENDING
    ) {
      return;   // cancelled between the sweep and here; the next sweep hands it back
    }

    if (op === OP_CONTINUE) {
      send(slot, pending[slot] ?? EMPTY);
      return;
    }
    // A piece of an oversized request, held here rather than in the worker for the same
    // reason the response tail is.
    if (op === OP_PUSH) {
      partial[slot].push(payload);
      reply(slot, STATUS_ACK, EMPTY);
      return;
    }

    let whole: Uint8Array = payload;
    if (partial[slot].length > 0) {
      whole = joined(partial[slot], payload);
      partial[slot] = [];
    }

    const h = handlers[op];
    if (h === undefined) {
      reply(slot, STATUS_ERR, faultedBytes(FAULT_OTHER, `no handler for capability ${op}`));
      return;
    }
    // Dispatched, not awaited: the loop goes back to watching immediately, so a slow
    // capability in one slot does not hold up the others.
    // Whether this answer still belongs in this slot.
    //
    // The generation, not the status. Checking for `ST_CANCELLED` was the same idea and did
    // not work: by the time a slow handler finishes, a cancelled slot has usually been swept
    // free *and claimed by another call*, so the status is `RUNNING` and the check passes —
    // and the stale answer is written into somebody else's slot and marked ready. Their
    // `waitAny` then reports a ticket that has not settled, which is wac-mono issue 0023: a
    // 30-second bound expiring after 15 because a 15-second timer was cancelled earlier.
    //
    // Nothing is freed on the way out. A cancelled slot is the sweep's to hand back, and if
    // the slot has been reused, touching it is the whole bug.
    const stillOurs = (): boolean => Atomics.load(b.ctrl, at + S_GEN) === gen;

    void (async () => {
      try {
        const out = await h(whole);
        if (!stillOurs()) return;
        send(slot, out);
      } catch (e) {
        if (!stillOurs()) return;
        // The worker turns this into a thrown HostCallError, so a capability failing is
        // an error in wac's caller rather than a silent wrong answer.
        // Classified *here*, once, rather than at each of the forty handlers: `faultOf` reads the
        // host's own exception, and every capability's failure gains a category for free. wac-mono 0062.
        reply(
          slot,
          STATUS_ERR,
          faultedBytes(faultOf(e), e instanceof Error ? e.message : String(e)),
        );
      }
    })();
  };

  const loop = async (): Promise<void> => {
    while (running && !opts.signal?.aborted) {
      // Loaded *before* the sweep, which is the same discipline the whole file uses:
      // anything arriving after this load changes the value, so the wait below returns
      // immediately rather than sleeping through it. Loading it after the sweep instead
      // made every call cost two turns of the event loop rather than one.
      const seen = Atomics.load(b.ctrl, SUBMIT_SEQ);
      for (let s = 0; s < SLOTS; s++) {
        const st = Atomics.load(b.ctrl, slotAt(s) + S_STATUS);
        if (st === ST_PENDING) take(s);
        else if (st === ST_CANCELLED) abandon(s);
      }
      const w = Atomics.waitAsync(b.ctrl, SUBMIT_SEQ, seen);
      if (w.async) await w.value;
      if (!running || opts.signal?.aborted) return;
    }
  };

  const done = loop();
  return {
    stop() {
      running = false;
      // Wake the loop so it can notice. Bumping the counter it waits on is the only way
      // in: it is parked on a value, not on a flag.
      Atomics.add(b.ctrl, SUBMIT_SEQ, 1);
      Atomics.notify(b.ctrl, SUBMIT_SEQ);
    },
    done,
  };
}
