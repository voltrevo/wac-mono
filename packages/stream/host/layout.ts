// The shared-memory layout, in one place so the worker and the host cannot disagree about it.
//
// Two byte rings and a control block. Each ring is a pair of *monotonic* counters — bytes ever
// written and bytes ever consumed — rather than wrapping indices: `head - tail` is the amount
// available and `CAP - (head - tail)` the space free, with no empty-versus-full ambiguity to get
// wrong. Only the byte offsets wrap.
//
// The counters are the synchronisation. Every read of data is preceded by an `Atomics.load` of the
// counter that published it and every write followed by an `Atomics.store`, which is what orders
// the plain byte copies between the two threads.

export const CAP = 1 << 16;                    // per ring

// Int32 slots in the control block.
export const IN_HEAD = 0;                      // bytes written by the producer
export const IN_TAIL = 1;                      // bytes taken by the transform
export const IN_EOF = 2;                       // producer has finished
export const OUT_HEAD = 3;                     // bytes written by the transform
export const OUT_TAIL = 4;                     // bytes taken by the consumer
export const OUT_DONE = 5;                     // transform returned
export const STATUS = 6;                       // its return value, or an error marker

// Event counters. A waiter sleeps on a *value*, so it can only be woken by that value changing —
// which means EOF and DONE, published in slots of their own, cannot wake anybody. A sleeper that
// checked them a moment before sleeping would then never be woken at all.
//
// So each direction gets a counter that every event of any kind bumps, and waiters sleep on that.
// Loading it *before* the checks is the whole of the correctness argument: anything that happens
// after the load changes the value, and `Atomics.wait` on a stale value returns at once.
export const IN_SEQ = 7;                       // input published, or input finished
export const OUT_SEQ = 8;                      // output published, or the transform returned
/**
 * The producer's source *failed*, as distinct from having finished — slot 9 of the sixteen.
 *
 * Both used to be `IN_EOF`, because the transform's `read()` answered bytes and an empty array was
 * the only thing it could say. So a producer that threw halfway looked exactly like one that had
 * finished: the transform completed, the stream closed cleanly, and the consumer was handed a
 * truncated result with nothing to indicate it. `Read.Failed` is what the transform sees now, and
 * this is how the producer says it.
 */
export const IN_ERR = 9;
export const CTRL_INTS = 16;

export const CTRL_BYTES = CTRL_INTS * 4;
export const IN_OFFSET = CTRL_BYTES;
export const OUT_OFFSET = IN_OFFSET + CAP;
export const TOTAL_BYTES = OUT_OFFSET + CAP;

/** A transform that ran to completion returns >= 0; anything else is a failure. */
export const STATUS_RUNNING = -100;
export const STATUS_THREW = -101;

export type Rings = {
  ctrl: Int32Array;
  inBytes: Uint8Array;
  outBytes: Uint8Array;
};

export function rings(sab: SharedArrayBuffer): Rings {
  return {
    ctrl: new Int32Array(sab, 0, CTRL_INTS),
    inBytes: new Uint8Array(sab, IN_OFFSET, CAP),
    outBytes: new Uint8Array(sab, OUT_OFFSET, CAP),
  };
}

/** Publish an event on `slot` and wake everyone sleeping on it. */
export function signal(ctrl: Int32Array, slot: number): void {
  Atomics.add(ctrl, slot, 1);
  Atomics.notify(ctrl, slot);
}

/** Copy `src` into a ring at monotonic position `head`, wrapping. */
export function ringWrite(ring: Uint8Array, head: number, src: Uint8Array): void {
  const start = head % CAP;
  const first = Math.min(src.length, CAP - start);
  ring.set(src.subarray(0, first), start);
  if (first < src.length) ring.set(src.subarray(first), 0);
}

/** Read `n` bytes from a ring at monotonic position `tail`, wrapping. */
export function ringRead(ring: Uint8Array, tail: number, n: number): Uint8Array {
  const start = tail % CAP;
  const first = Math.min(n, CAP - start);
  const out = new Uint8Array(n);
  out.set(ring.subarray(start, start + first), 0);
  if (first < n) out.set(ring.subarray(0, n - first), first);
  return out;
}
