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
  REQ_MORE,
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

/** One publish-and-park. Returns the host's status and a copy of its payload. */
function roundTrip(
  b: Bridge,
  op: number,
  payload: Uint8Array,
  more: number,
): { status: number; body: Uint8Array } {
  b.req.set(payload, 0);
  Atomics.store(b.ctrl, REQ_OP, op);
  Atomics.store(b.ctrl, REQ_LEN, payload.length);
  Atomics.store(b.ctrl, REQ_MORE, more);

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
  // A copy: the next call overwrites the buffer.
  return { status, body: b.res.slice(0, len) };
}

/**
 * Perform one host call and block until it answers.
 *
 * Both directions chunk, and they have to. A response too large for the buffer arrives in
 * pieces: the host says `STATUS_MORE`, we take what is there and ask again with
 * `OP_CONTINUE`. A *request* too large goes out the same way, each piece but the last
 * flagged `REQ_MORE` and answered with an empty OK.
 *
 * Only the response half existed at first, which made the bridge quietly asymmetric: a
 * `readFile` of ten megabytes worked and a `writeFile` of two threw. Every applet whose
 * output is its input — `cat`, `gzip`, `hex` — died above a megabyte, and `cp` turned the
 * throw into "cannot write", blaming the destination for a limit in the transport.
 */
export function hostCall(b: Bridge, op: number, payload: Uint8Array): Uint8Array {
  // Everything but the last chunk of the request, if it needs more than one.
  let sent = 0;
  while (payload.length - sent > BUF) {
    const ack = roundTrip(b, op, payload.subarray(sent, sent + BUF), 1);
    if (ack.status === STATUS_ERR) throw new HostCallError(dec.decode(ack.body));
    sent += BUF;
  }

  const parts: Uint8Array[] = [];
  let nextOp = op;
  let nextPayload = payload.subarray(sent);

  for (;;) {
    const { status, body } = roundTrip(b, nextOp, nextPayload, 0);
    if (status === STATUS_ERR) throw new HostCallError(dec.decode(body));
    parts.push(body);
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
