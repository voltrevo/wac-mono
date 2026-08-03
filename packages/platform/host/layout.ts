// The shared-memory layout for the host-call bridge, in one place so the worker and the
// main thread cannot disagree about it.
//
// `packages/stream` proved the mechanism: a worker may block, so `Atomics.wait` parks it
// with the wasm frame still on its stack while the main thread does something async and
// wakes it. This generalises that from one byte pipe to request/response, so *any* host
// operation can be made to look synchronous to wac.
//
// **Requests travel through this memory, not through `postMessage`.** That is the
// constraint stream found by getting it wrong: a blocked worker cannot deliver a message,
// so a handshake built on `postMessage` deadlocks on its first call. Here the worker
// writes its request into the buffer and bumps a counter; the main thread is parked on
// that counter with `Atomics.waitAsync`, so it wakes without ever blocking itself.
//
// Sequence counters rather than flags, for the reason stream documents: a waiter sleeps on
// a *value* and can only be woken by that value changing, so every event bumps a counter
// and waiters load it before checking anything. Anything happening after the load changes
// the value, and `Atomics.wait` on a stale value returns immediately.
//
// **A ring of slots, not one mailbox.** One mailbox allowed exactly one call in flight,
// which was fine while every capability blocked and stops being fine the moment a program
// wants to read two files at once, relay between two sockets, or wait on several children.
// `Atomics.wait` takes a single address, so "wait until any of these finishes" is a wait on
// `DONE_SEQ` followed by a scan — which is the whole reason that counter is separate from
// any per-slot state, and is also what makes `poll` over sockets fall out for free.

/**
 * How many calls one worker may have outstanding.
 *
 * **The count is a ceiling on how many handles a program can watch**, which is why it is
 * sixteen rather than four. Watching N handles means N outstanding `recv`s holding N slots,
 * and a program that also writes needs a slot for that — so four slots meant three handles,
 * and `example/pipe.wac` already watches three. A three-stage pipeline was not writable:
 * four reads in flight and the send has nowhere to go.
 *
 * That failure is worse than a limit, because it is not diagnosable. Held slots are RUNNING
 * rather than READY — the host *will* answer each read, once the peer speaks, and the peer
 * is waiting for the write that cannot be submitted. Indistinguishable from backpressure
 * from inside `claim`, so it parks silently and forever. Raising the ceiling does not remove
 * that shape; it moves it out to where real programs do not meet it.
 *
 * Submitting with no free slot still waits, which is backpressure rather than an error, and
 * is correct whenever the outstanding calls will finish on their own.
 */
export const SLOTS = 16;

/**
 * Payload bytes per slot, each way.
 *
 * `SLOTS * 2 * SLOT_BUF` is 4MB. Sixteen slots at the old 256KB would have been 8MB, and
 * halving the buffer to pay for four times the slots is the right side of that trade: the
 * buffer only decides how many round trips a *large* payload takes, while the slot count
 * decides which programs can be written at all.
 *
 * It must stay comfortably above `CHUNK`, not merely equal to it. A `send` of a full 64KB
 * chunk carries a four-byte handle in front, so a 64KB buffer would chunk every streaming
 * write in two — a round trip added to the hot path to save memory on the cold one.
 *
 * Measured on a 200MB file, which is the payload this actually governs — `sha256sum` reads it
 * whole through the chunked response path. Interleaved runs of the old and new sizes are
 * indistinguishable once the file is in page cache: 1.99, 1.92, 1.91s against 2.04, 2.00,
 * 1.99s. The first run of either is three to five times that and is disk, which is why the
 * comparison has to be interleaved and warm to say anything at all.
 */
export const SLOT_BUF = 1 << 17;

/**
 * What one `readChunk` hands back at most.
 *
 * Half of `SLOT_BUF`, so a chunk plus any header a capability puts in front of it never
 * itself needs chunking, and large enough that the per-call round trip is noise next to the
 * work done on it.
 */
export const CHUNK = 1 << 16;

// ── The control block ─────────────────────────────────────────────────────────

/** Bumped by the worker whenever a slot needs the host's attention. */
export const SUBMIT_SEQ = 0;
/** Bumped by the host whenever a slot changes in the worker's favour. */
export const DONE_SEQ = 1;
/** Ints before the per-slot blocks begin. */
export const CTRL_HEAD = 2;
/** Ints per slot. */
export const SLOT_INTS = 8;

// Offsets within a slot's block.
export const S_STATUS = 0;
export const S_OP = 1;
export const S_REQ_LEN = 2;
export const S_RES_LEN = 3;
export const S_RES_STATUS = 4;
/**
 * Bumped every time a slot is reused.
 *
 * A ticket is a slot *and* a generation. Without this, waiting on a ticket whose slot had
 * been recycled would read whatever call now occupies it — the worst kind of bug, because
 * the answer looks plausible.
 */
export const S_GEN = 5;

/** Nobody is using this slot. The worker allocates; only the worker sets this. */
export const ST_FREE = 0;
/** The worker has written a request and wants it run. */
export const ST_PENDING = 1;
/** The host has taken it and is working. */
export const ST_RUNNING = 2;
/** The host has written an answer. */
export const ST_READY = 3;
/** The worker abandoned it; the host frees the slot when the work lands. */
export const ST_CANCELLED = 4;
/**
 * Taken by the worker, and not yet a request: the opcode and payload are still being written.
 *
 * Separate from `ST_PENDING` because the host takes *anything* pending, and between claiming a
 * slot and writing the opcode into it there is nothing to take. Sharing one state left a window
 * where a sweep could dispatch a slot whose `S_OP` was still whatever the previous call left —
 * zero on a slot's first use, which surfaced as `no handler for capability 0`.
 *
 * The window was always there and was very hard to hit while the ring had four slots, because
 * the host was usually parked and the wake-up came from the `ping` *after* the write. At sixteen
 * it is already awake and sweeping when the next claim happens, and it showed up within three
 * full runs of the suite.
 */
export const ST_CLAIMED = 5;

/** The response is complete. */
export const STATUS_OK = 0;
/** The capability failed; the payload is a UTF-8 message. */
export const STATUS_ERR = 1;
/** What fits is here; ask again with `OP_CONTINUE` for the rest. */
export const STATUS_MORE = 2;
/** A chunk of an oversized *request* was taken; send the next. */
export const STATUS_ACK = 3;

/**
 * Ask for the tail of a response too large for the slot.
 *
 * Not a capability, so it is numbered where no opcode reaches — `ops.ts` counts up from 1.
 */
export const OP_CONTINUE = -1;
/** Set as the op while the worker is still feeding an oversized request. */
export const OP_PUSH = -2;

export const CTRL_INTS = CTRL_HEAD + SLOTS * SLOT_INTS;
export const CTRL_BYTES = CTRL_INTS * 4;
export const REQ_OFFSET = CTRL_BYTES;
export const RES_OFFSET = REQ_OFFSET + SLOTS * SLOT_BUF;
export const TOTAL_BYTES = RES_OFFSET + SLOTS * SLOT_BUF;

export type Bridge = {
  sab: SharedArrayBuffer;
  ctrl: Int32Array;
  /** Request payload for slot `i`. */
  req(i: number): Uint8Array;
  /** Response payload for slot `i`. */
  res(i: number): Uint8Array;
};

/** Where slot `i`'s control block starts. */
export function slotAt(i: number): number {
  return CTRL_HEAD + i * SLOT_INTS;
}

export function bridgeOf(sab: SharedArrayBuffer): Bridge {
  const ctrl = new Int32Array(sab, 0, CTRL_INTS);
  // Built once, not per call. Making these functions that construct a view on demand cost
  // an allocation on every submit, reply and collect — invisible on a single call and
  // worth two and a half times the whole test suite's runtime in a streaming loop.
  const reqs: Uint8Array[] = [];
  const ress: Uint8Array[] = [];
  for (let i = 0; i < SLOTS; i++) {
    reqs.push(new Uint8Array(sab, REQ_OFFSET + i * SLOT_BUF, SLOT_BUF));
    ress.push(new Uint8Array(sab, RES_OFFSET + i * SLOT_BUF, SLOT_BUF));
  }
  return { sab, ctrl, req: (i: number) => reqs[i], res: (i: number) => ress[i] };
}

export function newBridge(): Bridge {
  return bridgeOf(new SharedArrayBuffer(TOTAL_BYTES));
}
