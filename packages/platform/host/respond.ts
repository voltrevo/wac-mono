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
  acquireBuf,
  INLINE_BYTES,
  BUF_BYTES,
  releaseBuf,
  attach,
  detach,
  S_REQ_BUF,
  S_RES_BUF,
  SLOTS,
  slotAt,
  ST_CANCELLED,
  ST_FREE,
  ST_CLAIMED,
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
import { type Scheduler, scheduler } from "./schedule.ts";
import { describeSlots } from "./call.ts";

/** What a capability does with a request payload. May be async; that is the point. */
export type Handler = (payload: Uint8Array) => Uint8Array | Promise<Uint8Array>;

/** Capability implementations by opcode. */
export type Handlers = Record<number, Handler>;

const enc = new TextEncoder();
const EMPTY = new Uint8Array(0);


/** Labels bridges in the scheduler's log, so a recorded run can be read. */
let nextBridgeId = 0;

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
  opts: { signal?: AbortSignal; scheduler?: Scheduler } = {},
): { stats(): { running: boolean; sweeps: number }; stop(): void; done: Promise<void> } {
  let running = true;

  // The scheduler is shared by every bridge in this process, because the orderings worth exploring are
  // *between* a shell and the applets it spawned, not within one of them. The id only labels the log.
  // The process-wide one unless the caller brings its own. A test *about* the concurrent ring has to
  // bring `newScheduler("off")`: scheduling exists to remove the interleavings, and removing them is
  // exactly what such a test must not have done to it. See design/0001 D12's note on the testing gap.
  const sched = opts.scheduler ?? scheduler();
  const bridgeId = nextBridgeId++;
  // Registered so a stall anywhere can ask every bridge what it is doing — a shell parked reading a child
  // explains nothing without the child's side of it.
  //
  // The description says whether this bridge is still being served, because the interesting stall is a
  // worker parked against a host that stopped: `stop()` takes the bridge out of the survey, but a loop
  // that *died* leaves it in, and a slot table with no note would read as an ordinary busy bridge.
  sched.register(bridgeId, () => `${running ? "" : "responder stopped — "}${describeSlots(b)}`);

  // Per-slot state kept between the pieces of one call.
  const pending: (Uint8Array | null)[] = new Array(SLOTS).fill(null);      // response tail
  const finalStatus: number[] = new Array(SLOTS).fill(STATUS_OK);           // what the tail's last piece is
  const partial: Uint8Array[][] = Array.from({ length: SLOTS }, () => []); // request head

  const reply = (slot: number, status: number, body: Uint8Array): void => {
    // **Through the scheduler**, which with scheduling off calls this straight back — the path the host
    // has always taken. With it on, the answer joins a ready set and the scheduler decides which one
    // lands next, so the order the whole system runs in is chosen rather than raced for. See
    // `schedule.ts`, and design/0001 D12 for what that can and cannot promise.
    // The generation is read *now*, while the slot is still this call's, and travels with the answer
    // through both delays: the scheduler's, and the wait for a free buffer.
    const gen = Atomics.load(b.ctrl, slotAt(slot) + S_GEN);
    sched.ready(bridgeId, slot, () => write(slot, status, body, gen));
  };

  /**
   * Write an answer, in a pooled buffer when one is free and inline when not.
   *
   * `gen` is the generation the answer belongs to, and checking it is not optional. The answer may have
   * been held by the scheduler meanwhile, and the worker may have *cancelled* the call — the sweep then
   * frees the slot and a new call takes it at a new generation. Writing the old answer there delivers one
   * call's bytes to another, which the fuzzer caught on its first seed: `asked as 15, answered as 22`.
   *
   * **Never fails for want of a buffer.** An earlier version deferred instead, and deadlocked: the
   * buffers are held by answers the worker has not collected, and a worker parked on one specific call
   * collects nothing, so the call it waits for never lands. Inline is the guarantee; the pool is speed.
   */  const write = (slot: number, status: number, body: Uint8Array, gen: number): void => {
    const at = slotAt(slot);
    if (Atomics.load(b.ctrl, at + S_GEN) !== gen) return;   // recycled; this answer is for nobody
    // A pooled buffer if one is free, the slot's own inline area otherwise. The tail, if the chosen room
    // cannot hold it all, goes through the same `STATUS_MORE` path an oversized answer always used.
    const bi = body.length > INLINE_BYTES ? acquireBuf(b, "res") : -1;
    const room = bi >= 0 ? b.resBuf(bi) : b.inline(slot);
    const fits = Math.min(body.length, room.length);
    const tail = body.subarray(fits);
    room.set(body.subarray(0, fits), 0);
    attach(b, at, S_RES_BUF, bi);
    Atomics.store(b.ctrl, at + S_RES_LEN, fits);
    Atomics.store(b.ctrl, at + S_RES_STATUS, tail.length > 0 ? STATUS_MORE : status);
    if (tail.length > 0) {
      // Remembered here, and asked for with `OP_CONTINUE`. `finalStatus` so the last piece carries the
      // real answer status rather than `STATUS_MORE`.
      pending[slot] = tail;
      finalStatus[slot] = status;
    }

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
      // No longer ours; the sweep hands the slot back — and the buffer with it, or the pool leaks one
      // per losing race, which is a pool that empties over an hour and a hang nobody can explain.
      releaseBuf(b, "res", detach(b, at, S_RES_BUF));
      pending[slot] = null;
      return;
    }
    Atomics.add(b.ctrl, DONE_SEQ, 1);
    Atomics.notify(b.ctrl, DONE_SEQ);
  };

  /**
   * Answer. The splitting lives in `write`, which is the only place that knows how much room it got — a
   * pooled buffer or the slot's inline area — so deciding here as well would be two rules for one thing.
   */
  const send = (slot: number, body: Uint8Array): void => {
    reply(slot, STATUS_OK, body);
  };

  /** A slot the worker gave up on: drop what we know and hand it back. */
  const abandon = (slot: number): void => {
    pending[slot] = null;
    partial[slot] = [];
    // Both buffers, because a cancel can land at any point: the request may still be attached if the
    // sweep never took it, and the answer if it was written and never collected.
    const cancelled = slotAt(slot);
    for (const dir of ["req", "res"] as const) {
      releaseBuf(b, dir, detach(b, cancelled, dir === "req" ? S_REQ_BUF : S_RES_BUF));
    }
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
    // Copied out and the buffer released immediately: a request buffer is held for exactly one read, so
    // a worker parked for one waits on this line and nothing else.
    const rb = detach(b, at, S_REQ_BUF);
    const payload = rb < 0 ? EMPTY : b.reqBuf(rb).slice(0, len);
    releaseBuf(b, "req", rb);
    Atomics.add(b.ctrl, DONE_SEQ, 1);
    Atomics.notify(b.ctrl, DONE_SEQ);

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
      // The status the *whole* answer had, kept from the first piece: a failure delivered in two pieces is
      // still a failure, and sending the tail as `STATUS_OK` would turn it into a successful empty answer.
      const tail = pending[slot] ?? EMPTY;
      pending[slot] = null;
      reply(slot, finalStatus[slot], tail);
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

  /** Sweeps completed, so a stalled caller can tell a parked responder from a dead one. */
  let sweeps = 0;

  /**
   * Answer every slot still holding a request, so a parked worker learns rather than waits.
   *
   * A worker in `Atomics.wait` is waiting for *this* loop and nothing else. If the loop stops — an
   * exception, or a bug that lets it park with work outstanding — the worker waits for ever, and what
   * that looks like from outside is a test that hangs with no message anywhere. wac-mono 0082 spent
   * three days as that shape. A failure the worker can see is worth more than a tidy stack trace here.
   */
  const failPending = (why: string): void => {
    for (let s = 0; s < SLOTS; s++) {
      const st = Atomics.load(b.ctrl, slotAt(s) + S_STATUS);
      if (st === ST_PENDING || st === ST_CLAIMED) {
        try {
          reply(s, STATUS_ERR, faultedBytes(FAULT_OTHER, why));
        } catch {
          // Nothing better to do: the bridge is already in a state we are explaining.
        }
      }
    }
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
      sweeps++;
      // The worker has come back: whatever it was answered with, it is parked again. That is the signal
      // the scheduler waits on before letting another worker run — see `schedule.ts`.
      sched.quiet(bridgeId);
      const w = Atomics.waitAsync(b.ctrl, SUBMIT_SEQ, seen);
      if (w.async) await w.value;
      if (!running || opts.signal?.aborted) return;
    }
  };

  // **A responder that dies must not leave its worker parked.** `loop()`'s promise is not awaited by
  // most callers, so a rejection here used to disappear: the loop stopped, the slots stayed pending, and
  // the worker waited for an answer that could no longer come. Now the failure reaches the worker as a
  // failed host call — which a program reports in its own words — and is said out loud besides.
  const done = loop().catch((e: unknown) => {
    const why = `the host responder stopped: ${e instanceof Error ? e.message : String(e)}`;
    try {
      console.error(`wac: ${why}`);
    } catch {
      // A closed stderr is not a reason to skip the part that unparks the worker.
    }
    failPending(why);
    throw e;
  });
  return {
    /** Whether the loop is still going, and how many sweeps it has made. For a caller narrating a stall. */
    stats() {
      return { running, sweeps };
    },
    stop() {
      running = false;
      sched.quiet(bridgeId);
      sched.forget(bridgeId);
      // Wake the loop so it can notice. Bumping the counter it waits on is the only way
      // in: it is parked on a value, not on a flag.
      Atomics.add(b.ctrl, SUBMIT_SEQ, 1);
      Atomics.notify(b.ctrl, SUBMIT_SEQ);
    },
    done,
  };
}
