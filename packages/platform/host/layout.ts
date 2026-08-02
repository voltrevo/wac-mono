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
 * Four rather than more because each slot costs its own payload space both ways, and the
 * point is to overlap a handful of operations rather than to queue hundreds. Submitting
 * with no free slot waits for one, which is backpressure rather than an error.
 */
export const SLOTS = 4;

/**
 * Payload bytes per slot, each way.
 *
 * `SLOTS * 2 * SLOT_BUF` is 2MB, which is exactly what the single mailbox cost, so a worker
 * is no more expensive than it was. Anything larger chunks, as it did when the buffer was
 * one megabyte — that machinery is per slot now.
 */
export const SLOT_BUF = 1 << 18;

/**
 * What one `readChunk` hands back at most.
 *
 * Well under `SLOT_BUF`, so a chunk never itself needs chunking, and large enough that the
 * per-call round trip is noise next to the work done on it.
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
