// The worker: where the wac transform runs, and where blocking is allowed.
//
// This is the whole trick. wac cannot yield, so a pull-based transform needs its `read()` to
// *block* until more input exists — and a worker may block. `Atomics.wait` suspends the thread
// with the wasm frame still on it, and the producer on the main thread wakes it.
//
// Two constraints, both found by getting them wrong first:
//
//   - `onmessage` is installed before any top-level `await`. Module evaluation suspends at the
//     first await, and a message arriving in that window is lost.
//   - the feed is push-only. A blocked worker cannot deliver a `postMessage`, so it cannot ask
//     for the next chunk — a request/response handshake deadlocks on the first read.

import {
  CAP,
  IN_EOF,
  IN_HEAD,
  IN_SEQ,
  IN_TAIL,
  IN_ERR,
  OUT_DONE,
  OUT_HEAD,
  OUT_SEQ,
  OUT_TAIL,
  rings,
  ringRead,
  ringWrite,
  signal,
  STATUS,
  STATUS_THREW,
} from "./layout.ts";

type Start = { sab: SharedArrayBuffer; modulePath: string; entry: string };

// Deno type-checks this file against the window lib, not the worker one, so `self` needs saying.
const worker = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
};

let pending: Start | null = null;
let ready: ((s: Start) => void) | null = null;
worker.onmessage = (e: MessageEvent) => {
  const start = e.data as Start;
  if (ready !== null) ready(start);
  else pending = start;
};

const { wacBind } = await import("../../../harness/wacBind.ts");

const start: Start = pending ?? await new Promise<Start>(resolve => {
  ready = resolve;
});

const mod = await wacBind(start.modulePath) as unknown as Record<string, unknown>;
// `Read` comes from the module the transform lives in, since a wac enum crosses as a class with a
// static per variant. A producer on this side now has to say which of the three it means — the whole
// point of the type, and the reason this file can no longer answer "nothing" ambiguously.
const Read = mod.Read as {
  Data(bytes: Uint8Array): unknown;
  End(): unknown;
  Failed(why: string): unknown;
};
const transform = mod[start.entry] as (
  read: () => unknown,
  write: (b: Uint8Array) => boolean,
) => number;

const { ctrl, inBytes, outBytes } = rings(start.sab);

/**
 * Block until input is available, then take as much as is there.
 *
 * Answers a `Read`: `End` when the producer has said it is finished, and `Failed` if it reported an
 * error. It used to answer an empty array for the first and had no way to say the second, so a
 * producer whose source threw looked exactly like one that had finished — the transform completed,
 * the stream closed cleanly, and the consumer got a truncated result with no indication.
 */
function read(): unknown {
  while (true) {
    const seq = Atomics.load(ctrl, IN_SEQ);      // before the checks below, never after
    const head = Atomics.load(ctrl, IN_HEAD);
    const tail = Atomics.load(ctrl, IN_TAIL);
    const available = head - tail;
    if (available > 0) {
      const chunk = ringRead(inBytes, tail, available);
      Atomics.store(ctrl, IN_TAIL, tail + available);
      Atomics.notify(ctrl, IN_TAIL);          // the producer may be waiting for space
      return Read.Data(chunk);
    }
    if (Atomics.load(ctrl, IN_ERR) === 1) return Read.Failed("the producer reported an error");
    if (Atomics.load(ctrl, IN_EOF) === 1) return Read.End();
    // Nothing to take and not finished: sleep until the producer publishes more. The wasm frame
    // stays on this thread's stack across the wait.
    Atomics.wait(ctrl, IN_SEQ, seq);
  }
}

/** Publish output, blocking while the consumer is behind. Always true: there is no cancel yet. */
function write(bytes: Uint8Array): boolean {
  let at = 0;
  while (at < bytes.length) {
    const head = Atomics.load(ctrl, OUT_HEAD);
    const tail = Atomics.load(ctrl, OUT_TAIL);
    const free = CAP - (head - tail);
    if (free === 0) {
      Atomics.wait(ctrl, OUT_TAIL, tail);     // back-pressure, from the consumer
      continue;
    }
    const n = Math.min(free, bytes.length - at);
    ringWrite(outBytes, head, bytes.subarray(at, at + n));
    Atomics.store(ctrl, OUT_HEAD, head + n);
    signal(ctrl, OUT_SEQ);
    at += n;
  }
  return true;
}

let status: number;
try {
  status = transform(read, write);
} catch {
  // A trap in wac arrives here. The consumer has to learn about it, or it waits for ever.
  status = STATUS_THREW;
}
Atomics.store(ctrl, STATUS, status);
Atomics.store(ctrl, OUT_DONE, 1);
signal(ctrl, OUT_SEQ);                        // wake a consumer waiting on output
