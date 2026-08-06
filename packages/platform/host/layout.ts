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
export const SLOTS = 128;

/**
 * How many payload buffers there are, per direction, and how big each is.
 *
 * **A slot no longer owns a buffer.** It used to: sixteen slots each reserved 128 KiB in each direction,
 * so a program's *fan-in* — how many calls it can have outstanding — was priced in megabytes of mostly
 * empty memory. A server holding sixteen idle `recv`s reserved 4 MB to hold nothing, and `packages/tor`'s
 * relay needs 1 + 2 per circuit outstanding, which exceeds sixteen with a single connection at full
 * circuits. Exceeding the ring does not degrade; it parks for ever.
 *
 * So this is the descriptor-ring-and-buffer-pool shape a network card uses. A slot is a 32-byte control
 * record, and a payload buffer is acquired only while bytes are actually moving. 128 slots cost 4 KiB of
 * control; sixteen buffers cost 2 MB. That is **half the memory for eight times the fan-in**, and the
 * scarce resource is now bandwidth rather than concurrency, which is the one you can back-pressure
 * without deadlocking.
 *
 * **Two pools, not one, and that is what makes it safe.** A request buffer is released by the *host* when
 * it takes the call; a response buffer by the *worker* when it collects. With one pool a worker could park
 * waiting for a buffer that only it can free. With two, each side only ever waits on the other, and the
 * other always makes progress.
 */
export const BUFS = 8;

/**
 * Bytes of answer that fit in the slot itself, without a pooled buffer.
 *
 * **This is what makes the pool an optimisation rather than a requirement**, and it is not decoration: a
 * shared pool alone deadlocks. An answer that cannot get a buffer has to wait for one, the buffers are
 * held by answers the worker has not collected, and a worker parked on one specific call will not collect
 * anything — so the call it is waiting for can never land. The fuzzer found that immediately, as a hang.
 *
 * With an inline area every answer can *always* be written, in chunks if need be: the response path
 * already carries a tail through `STATUS_MORE` and `OP_CONTINUE`, so a pooled buffer only decides whether
 * a large answer takes one round trip or many.
 *
 * **Which makes this the fallback path's bandwidth**, and the first version got it wrong. At 256 bytes a
 * 1 MiB answer that misses the pool takes four thousand round trips, and `bench/ring.ts` duly showed a
 * cliff — 32 concurrent large answers cost seven times what 8 did, because everything past the eighth
 * crawled. The sweep, 300 × 1 MiB with 32 in flight:
 *
 *   inline    256B   1KiB   2KiB   4KiB   8KiB
 *   time     1694ms  712ms  512ms  384ms  300ms
 *   bridge   2.04MiB 2.13   2.25   2.50   3.00
 *
 * 4 KiB is the knee: four times better than 256 bytes for less than half a megabyte, and past it the
 * memory grows faster than the saving. A pool that is merely *busy* now costs round trips in proportion,
 * rather than falling off a cliff nobody would connect to the pool being full.
 */
export const INLINE_BYTES = 4096;

/**
 * What one pooled buffer holds, each way.
 *
 * `BUFS * 2 * BUF_BYTES` is 2MB, and it is the whole of what this bridge reserves for payloads — it used
 * to be per *slot*, which is why raising the slot count used to cost memory at all. What the size decides
 * now is only how many round trips a large payload takes, and how much is pinned while one is in flight.
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
export const BUF_BYTES = 1 << 17;

/**
 * What one `readChunk` hands back at most.
 *
 * Half of `BUF_BYTES`, so a chunk plus any header a capability puts in front of it never
 * itself needs chunking, and large enough that the per-call round trip is noise next to the
 * work done on it.
 */
export const CHUNK = 1 << 16;

// ── The control block ─────────────────────────────────────────────────────────

/** Bumped by the worker whenever a slot needs the host's attention. */
export const SUBMIT_SEQ = 0;
/** Bumped by the host whenever a slot changes in the worker's favour. */
export const DONE_SEQ = 1;

/**
 * Non-zero once the host has stopped answering, so a parked worker learns instead of waiting.
 *
 * A worker in `Atomics.wait` is waiting for the responder loop and nothing else. Answering its
 * outstanding calls is not enough on its own: a worker can be parked with *nothing* outstanding — waiting
 * for a free slot, or for a request buffer, or holding a slot it has claimed but not yet published — and
 * in every one of those states the only thing that can wake it is the loop that has just gone away. What
 * that looks like from outside is a program that stops with no error anywhere, which is the shape
 * wac-mono 0082 spent three days being.
 *
 * So the host sets this and bumps `DONE_SEQ`; every park in `call.ts` rechecks it on waking and raises.
 * A flag rather than a per-slot status because the states that need it have no slot to write into.
 */
export const HOST_GONE = 2;

/** Ints before the per-slot blocks begin. */
export const CTRL_HEAD = 3;
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

/**
 * Which pooled buffer currently carries this slot's request. **One-based**; read it with `attached`.
 *
 * Attached when the worker publishes and detached by the host as it takes the call — a request buffer is
 * held for exactly one host-side read.
 */
export const S_REQ_BUF = 6;

/** Which pooled buffer carries this slot's answer, one-based. Held until the worker collects. */
export const S_RES_BUF = 7;

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

/**
 * One flag per buffer, per direction: 0 free, 1 held.
 *
 * A flag array with a compare-and-exchange per entry rather than a linked free list, because a Treiber
 * stack in shared memory has an ABA problem and this repo has already paid twice for subtle lock-free
 * mistakes in this file's neighbours. Eight entries make the scan free, and the failure mode of a scan is
 * "did not find one", which is a state the callers already have to handle.
 */
export const REQ_FREE_AT = CTRL_HEAD;
export const RES_FREE_AT = REQ_FREE_AT + BUFS;
const SLOTS_AT = RES_FREE_AT + BUFS;

export const CTRL_INTS = SLOTS_AT + SLOTS * SLOT_INTS;
export const CTRL_BYTES = CTRL_INTS * 4;
export const REQ_OFFSET = CTRL_BYTES;
export const RES_OFFSET = REQ_OFFSET + BUFS * BUF_BYTES;
export const INLINE_OFFSET = RES_OFFSET + BUFS * BUF_BYTES;
export const TOTAL_BYTES = INLINE_OFFSET + SLOTS * INLINE_BYTES;

export type Bridge = {
  sab: SharedArrayBuffer;
  ctrl: Int32Array;
  /** Pooled request buffer `i`. */
  reqBuf(i: number): Uint8Array;
  /** Pooled response buffer `i`. */
  resBuf(i: number): Uint8Array;
  /** Slot `i`'s inline answer area — always available, and small. */
  inline(i: number): Uint8Array;
};

/** Which pool: requests are freed by the host, responses by the worker. */
export type Dir = "req" | "res";

/**
 * Take a buffer, or -1 when they are all busy.
 *
 * Never blocks: a caller that cannot get one has to decide what to do — the worker parks and retries, the
 * host holds the answer until one frees. Blocking here would put the decision in the wrong place.
 */
export function acquireBuf(b: Bridge, dir: Dir): number {
  const base = dir === "req" ? REQ_FREE_AT : RES_FREE_AT;
  for (let i = 0; i < BUFS; i++) {
    if (Atomics.compareExchange(b.ctrl, base + i, 0, 1) === 0) return i;
  }
  return -1;
}

/** Give one back. Idempotent for -1, which is what an unattached slot carries. */
export function releaseBuf(b: Bridge, dir: Dir, i: number): void {
  if (i < 0) return;
  Atomics.store(b.ctrl, (dir === "req" ? REQ_FREE_AT : RES_FREE_AT) + i, 0);
}

/**
 * Buffer handles live in shared memory **one-based**, so zero — what memory starts as — means "none".
 *
 * This is not a style choice. With -1 for "none", every slot of a fresh bridge claimed to hold pooled
 * buffer 0, and the first `release` of an untouched slot handed that buffer back while a live answer was
 * still writing in it. Two slots then pointed at one buffer and the worker read one call's answer out of
 * another's: `asked as 15, answered as 24`. Zero-means-none cannot be forgotten by a slot nobody has
 * initialised, which is the only version of this that stays correct as slots and paths are added.
 */
export function attach(b: Bridge, at: number, field: number, i: number): void {
  Atomics.store(b.ctrl, at + field, i + 1);
}

/** What is attached, or -1. Leaves the field alone. */
export function attached(b: Bridge, at: number, field: number): number {
  return Atomics.load(b.ctrl, at + field) - 1;
}

/**
 * Detach, and say what was there — or -1 if nothing was.
 *
 * An exchange rather than a load and a store, because both sides can reach a handle at once: the host
 * takes a request while the worker cancels the call, and a cancel sweep frees the same slot. Read-then-
 * clear lets both see the same index and both release it, which is the double free this encoding exists
 * to make impossible.
 */
export function detach(b: Bridge, at: number, field: number): number {
  return Atomics.exchange(b.ctrl, at + field, 0) - 1;
}

/** Where slot `i`'s control block starts. */
export function slotAt(i: number): number {
  return SLOTS_AT + i * SLOT_INTS;
}

export function bridgeOf(sab: SharedArrayBuffer): Bridge {
  const ctrl = new Int32Array(sab, 0, CTRL_INTS);
  // Built once, not per call. Making these functions that construct a view on demand cost
  // an allocation on every submit, reply and collect — invisible on a single call and
  // worth two and a half times the whole test suite's runtime in a streaming loop.
  const reqs: Uint8Array[] = [];
  const ress: Uint8Array[] = [];
  for (let i = 0; i < BUFS; i++) {
    reqs.push(new Uint8Array(sab, REQ_OFFSET + i * BUF_BYTES, BUF_BYTES));
    ress.push(new Uint8Array(sab, RES_OFFSET + i * BUF_BYTES, BUF_BYTES));
  }
  const inlines: Uint8Array[] = [];
  for (let i = 0; i < SLOTS; i++) {
    inlines.push(new Uint8Array(sab, INLINE_OFFSET + i * INLINE_BYTES, INLINE_BYTES));
  }
  return {
    sab,
    ctrl,
    reqBuf: (i: number) => reqs[i],
    resBuf: (i: number) => ress[i],
    inline: (i: number) => inlines[i],
  };
}

export function newBridge(): Bridge {
  return bridgeOf(new SharedArrayBuffer(TOTAL_BYTES));
}
