// The worker side of the bridge: a synchronous call into the host, from a thread that
// is allowed to block.
//
// This is what the capability closures are built from. A wac program calls
// `caps.readFile(path)` as an ordinary function; the closure behind it calls `hostCall`,
// which parks this thread until the main thread has done whatever asynchronous work the
// operation needs. The wac frame stays on the stack throughout and never learns that
// anything waited.
//
// Only ever call this on a worker. `Atomics.wait` throws on a browser's main thread, and
// on Deno's it would block the very thread that has to answer — a deadlock rather than an
// error, which is worse.

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
} from "./layout.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Raised when a capability reports failure. The message is the host's. */
export class HostCallError extends Error {}

/**
 * Perform one host call and block until it answers.
 *
 * A response too large for the buffer arrives in chunks: the host says `STATUS_MORE`, we
 * take what is there and ask again with `OP_CONTINUE`. That keeps a `readFile` of
 * something larger than the buffer working rather than turning it into an error nobody
 * expected.
 */
export function hostCall(b: Bridge, op: number, payload: Uint8Array): Uint8Array {
  if (payload.length > BUF) {
    throw new HostCallError(`request of ${payload.length} bytes exceeds the ${BUF}-byte buffer`);
  }
  const parts: Uint8Array[] = [];
  let nextOp = op;
  let nextPayload = payload;

  for (;;) {
    b.req.set(nextPayload, 0);
    Atomics.store(b.ctrl, REQ_OP, nextOp);
    Atomics.store(b.ctrl, REQ_LEN, nextPayload.length);

    // Loaded *before* the request is published: anything the host does afterwards
    // changes this value, so a wait on it cannot sleep through the answer.
    const seen = Atomics.load(b.ctrl, RES_SEQ);
    Atomics.add(b.ctrl, REQ_SEQ, 1);
    Atomics.notify(b.ctrl, REQ_SEQ);

    while (Atomics.load(b.ctrl, RES_SEQ) === seen) {
      Atomics.wait(b.ctrl, RES_SEQ, seen);
    }

    const status = Atomics.load(b.ctrl, RES_STATUS);
    const len = Atomics.load(b.ctrl, RES_LEN);
    const chunk = b.res.slice(0, len); // a copy: the next call overwrites the buffer
    if (status === STATUS_ERR) throw new HostCallError(dec.decode(chunk));
    parts.push(chunk);
    if (status !== STATUS_MORE) break;
    nextOp = OP_CONTINUE;
    nextPayload = new Uint8Array(0);
  }

  if (parts.length === 1) return parts[0];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// ── Payload encoding ──────────────────────────────────────────────────────────
// Each capability decides its own shape; these are the pieces they are built from.
// Deliberately plain — the bridge moves bytes, and a capability that needs structure
// spells it out rather than inheriting a serialisation format nobody chose.

export const str = (s: string): Uint8Array => enc.encode(s);
export const unstr = (b: Uint8Array): string => dec.decode(b);

export function i32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n, true);
  return b;
}

export function readI32le(b: Uint8Array, at = 0): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getInt32(at, true);
}

export function i64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, n, true);
  return b;
}

export function readI64le(b: Uint8Array, at = 0): bigint {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigInt64(at, true);
}
