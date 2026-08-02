// The main-thread side of the bridge: answer host calls without ever blocking.
//
// `Atomics.waitAsync` is the counterpart to the worker's `Atomics.wait` — it returns a
// promise rather than parking the thread, so the event loop keeps running and the
// asynchronous work a capability needs can actually happen. A main thread that blocked
// here would deadlock against the worker waiting on it.

import {
  type Bridge,
  BUF,
  OP_CONTINUE,
  REQ_LEN,
  REQ_OP,
  REQ_SEQ,
  RES_LEN,
  RES_SEQ,
  RES_STATUS,
  STATUS_ERR,
  STATUS_MORE,
  STATUS_OK,
} from "./layout.ts";

/** What a capability does with a request payload. May be async; that is the point. */
export type Handler = (payload: Uint8Array) => Uint8Array | Promise<Uint8Array>;

/** Capability implementations by opcode. */
export type Handlers = Record<number, Handler>;

const enc = new TextEncoder();

/**
 * Serve host calls until `stop()` is called or the signal aborts.
 *
 * A response larger than the buffer is handed over in pieces: what fits goes now with
 * `STATUS_MORE`, and the rest waits for the worker's `OP_CONTINUE`. The remainder is held
 * here rather than in the worker so a caller that abandons a call cannot leak it.
 */
export function serveHostCalls(
  b: Bridge,
  handlers: Handlers,
  opts: { signal?: AbortSignal } = {},
): { stop(): void; done: Promise<void> } {
  let running = true;
  let pending: Uint8Array | null = null; // the tail of an oversized response

  const reply = (status: number, body: Uint8Array): void => {
    b.res.set(body, 0);
    Atomics.store(b.ctrl, RES_LEN, body.length);
    Atomics.store(b.ctrl, RES_STATUS, status);
    Atomics.add(b.ctrl, RES_SEQ, 1);
    Atomics.notify(b.ctrl, RES_SEQ);
  };

  const send = (body: Uint8Array): void => {
    if (body.length <= BUF) { pending = null; reply(STATUS_OK, body); return; }
    pending = body.subarray(BUF);
    reply(STATUS_MORE, body.subarray(0, BUF));
  };

  const loop = async (): Promise<void> => {
    let seen = Atomics.load(b.ctrl, REQ_SEQ);
    while (running && !opts.signal?.aborted) {
      const w = Atomics.waitAsync(b.ctrl, REQ_SEQ, seen);
      if (w.async) await w.value;
      if (!running || opts.signal?.aborted) return;
      seen = Atomics.load(b.ctrl, REQ_SEQ);

      const op = Atomics.load(b.ctrl, REQ_OP);
      const len = Atomics.load(b.ctrl, REQ_LEN);
      const payload = b.req.slice(0, len);

      if (op === OP_CONTINUE) {
        const rest = pending ?? new Uint8Array(0);
        send(rest);
        continue;
      }
      const h = handlers[op];
      if (h === undefined) {
        reply(STATUS_ERR, enc.encode(`no handler for capability ${op}`));
        continue;
      }
      try {
        send(await h(payload));
      } catch (e) {
        // The worker turns this into a thrown HostCallError, so a capability failing is
        // an error in wac's caller rather than a silent wrong answer.
        reply(STATUS_ERR, enc.encode(e instanceof Error ? e.message : String(e)));
      }
    }
  };

  const done = loop();
  return {
    stop() {
      running = false;
      // Wake the loop so it can notice. Bumping the counter it waits on is the only way
      // in: it is parked on a value, not on a flag.
      Atomics.add(b.ctrl, REQ_SEQ, 1);
      Atomics.notify(b.ctrl, REQ_SEQ);
    },
    done,
  };
}
