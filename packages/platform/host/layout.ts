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

/** Bytes for the request and response payloads. One page each is far past any capability. */
export const BUF = 1 << 20;

/**
 * What one `readChunk` hands back at most.
 *
 * Well under `BUF`, so a chunk never itself needs chunking, and large enough that the
 * per-call round trip is noise next to the work done on it.
 */
export const CHUNK = 1 << 16;

// Int32 slots in the control block.
export const REQ_SEQ = 0; // bumped by the worker when a request is ready
export const RES_SEQ = 1; // bumped by the main thread when a response is ready
export const REQ_OP = 2; // which capability
export const REQ_LEN = 3; // bytes of request payload
export const RES_LEN = 4; // bytes of response payload
export const RES_STATUS = 5; // see STATUS_* below
// Set on every chunk of a request too large for the buffer except its last. The host
// accumulates and answers each one with an empty OK; the handler runs on the last.
// Requests needed this for the same reason responses did — see the note on STATUS_MORE —
// and until they had it, `cp` of a 2MB file reported "cannot write".
export const REQ_MORE = 6;
export const CTRL_INTS = 16;

export const CTRL_BYTES = CTRL_INTS * 4;
export const REQ_OFFSET = CTRL_BYTES;
export const RES_OFFSET = REQ_OFFSET + BUF;
export const TOTAL_BYTES = RES_OFFSET + BUF;

/** The response is complete. */
export const STATUS_OK = 0;
/** The capability failed; the payload is a UTF-8 message. */
export const STATUS_ERR = 1;
/** More follows: take this chunk, then send OP_CONTINUE for the next. */
export const STATUS_MORE = 2;

/** Ask for the next chunk of a response that did not fit. */
export const OP_CONTINUE = -1;

export type Bridge = {
  sab: SharedArrayBuffer;
  ctrl: Int32Array;
  req: Uint8Array;
  res: Uint8Array;
};

export function bridgeOf(sab: SharedArrayBuffer): Bridge {
  return {
    sab,
    ctrl: new Int32Array(sab, 0, CTRL_INTS),
    req: new Uint8Array(sab, REQ_OFFSET, BUF),
    res: new Uint8Array(sab, RES_OFFSET, BUF),
  };
}

export function newBridge(): Bridge {
  return bridgeOf(new SharedArrayBuffer(TOTAL_BYTES));
}
