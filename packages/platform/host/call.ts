// The worker side of the bridge: submit a call, and later collect its answer.
//
// This is what the capability closures are built from. A wac program calls
// `caps.readFile(path)` and the closure behind it submits into a free slot and parks this
// thread until the answer lands. The wac frame stays on the stack throughout and never
// learns that anything waited.
//
// Only ever call these on a worker. `Atomics.wait` throws on a browser's main thread, and
// on Deno's it would block the very thread that has to answer — a deadlock rather than an
// error, which is worse.
//
// **Submitting does not block.** That is the point of the split: a caller may put several
// calls in flight and then wait for whichever finishes first. `hostCall` is a submit
// followed immediately by a collect, and does exactly the same atomics the single-mailbox
// version did — store the payload, publish, park — so nothing that does not overlap pays
// for the ability to.

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
  SLOT_BUF,
  SLOTS,
  slotAt,
  ST_CANCELLED,
  ST_FREE,
  ST_PENDING,
  ST_READY,
  STATUS_ERR,
  STATUS_MORE,
  SUBMIT_SEQ,
} from "./layout.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Raised when a capability reports failure. The message is the host's. */
export class HostCallError extends Error {}

/**
 * A call in flight.
 *
 * The generation is not decoration: slots are reused, and waiting on a ticket whose slot
 * had been recycled would read whatever call now occupies it — which is the worst kind of
 * bug, because the answer looks plausible.
 */
export type Ticket = { slot: number; gen: number };

/** Publish a slot's state change and wake the host. */
function ping(b: Bridge): void {
  Atomics.add(b.ctrl, SUBMIT_SEQ, 1);
  Atomics.notify(b.ctrl, SUBMIT_SEQ);
}

/** Park until the host changes something, then look again. */
function parkForHost(b: Bridge, seen: number): void {
  Atomics.wait(b.ctrl, DONE_SEQ, seen);
}

/**
 * Take a free slot, waiting for one if all are busy.
 *
 * Waiting rather than failing is deliberate: a program submitting more than `SLOTS` calls
 * is asking for more concurrency than the bridge has, and backpressure is the useful
 * answer. An error here would have to be handled by waiting anyway.
 */
function claim(b: Bridge): number {
  for (;;) {
    const seen = Atomics.load(b.ctrl, DONE_SEQ);
    let ready = 0;
    for (let i = 0; i < SLOTS; i++) {
      const at = slotAt(i);
      if (Atomics.compareExchange(b.ctrl, at + S_STATUS, ST_FREE, ST_PENDING) === ST_FREE) {
        return i;
      }
      if (Atomics.load(b.ctrl, at + S_STATUS) === ST_READY) ready++;
    }
    // Parking here is normal backpressure — every slot is busy and the host will finish one.
    //
    // Every slot being `ST_READY` is not that. A ready slot holds an answer, and only *this*
    // thread frees one, by collecting or cancelling; the host cannot. So this thread is
    // waiting for something that can only happen after it stops waiting, and parking would
    // be permanent. Safe to conclude without a race, because `ST_READY` moves only from
    // here: the host's transitions all end at it.
    //
    // Worth an error rather than a hang because the cause is a specific mistake with an
    // obvious fix, and because a silent permanent park is exactly the failure mode issue
    // 0018 was filed about. `waitAny` returns which ticket settled and collects nothing, so
    // the tickets that lost — most often a timer used as a deadline — are still holding
    // slots until they are waited on or cancelled.
    if (ready === SLOTS) {
      throw new HostCallError(
        `all ${SLOTS} call slots hold answers that were never taken. A ticket you stopped ` +
          `waiting on has to be cancelled: waitAny tells you which one settled and collects ` +
          `nothing, so the losers keep their slots. Bind the ticket and cancel() it — a ` +
          `timer written inline in the waitAny list cannot be cancelled at all.`,
      );
    }
    parkForHost(b, seen);
  }
}

/** Park until this slot has an answer. */
function awaitReady(b: Bridge, slot: number): void {
  const at = slotAt(slot);
  for (;;) {
    const seen = Atomics.load(b.ctrl, DONE_SEQ);
    if (Atomics.load(b.ctrl, at + S_STATUS) === ST_READY) return;
    parkForHost(b, seen);
  }
}

/** Give the slot back and move its generation on, so stale tickets read as expired. */
function release(b: Bridge, slot: number): void {
  const at = slotAt(slot);
  Atomics.add(b.ctrl, at + S_GEN, 1);
  Atomics.store(b.ctrl, at + S_STATUS, ST_FREE);
  // Someone may be parked because every slot was busy.
  Atomics.add(b.ctrl, DONE_SEQ, 1);
  Atomics.notify(b.ctrl, DONE_SEQ);
}

/**
 * Start a call. Returns without waiting for it.
 *
 * A payload larger than one slot goes in pieces: each but the last is flagged `OP_PUSH`
 * and answered with an empty acknowledgement, and the handler runs on the last. Both
 * directions have to chunk — a `readFile` of ten megabytes and a `writeFile` of two are
 * the same problem, and until requests chunked, `cp` of a 2MB file reported "cannot write"
 * and blamed the destination for a limit in the transport.
 */
export function submit(b: Bridge, op: number, payload: Uint8Array): Ticket {
  const slot = claim(b);
  const at = slotAt(slot);
  const gen = Atomics.load(b.ctrl, at + S_GEN);
  const buf = b.req(slot);

  let sent = 0;
  while (payload.length - sent > SLOT_BUF) {
    buf.set(payload.subarray(sent, sent + SLOT_BUF), 0);
    Atomics.store(b.ctrl, at + S_OP, OP_PUSH);
    Atomics.store(b.ctrl, at + S_REQ_LEN, SLOT_BUF);
    Atomics.store(b.ctrl, at + S_STATUS, ST_PENDING);
    ping(b);
    awaitReady(b, slot);
    if (Atomics.load(b.ctrl, at + S_RES_STATUS) === STATUS_ERR) {
      const msg = dec.decode(b.res(slot).slice(0, Atomics.load(b.ctrl, at + S_RES_LEN)));
      release(b, slot);
      throw new HostCallError(msg);
    }
    sent += SLOT_BUF;   // acknowledged; the host is waiting for the next piece
  }

  const tail = payload.subarray(sent);
  buf.set(tail, 0);
  Atomics.store(b.ctrl, at + S_OP, op);
  Atomics.store(b.ctrl, at + S_REQ_LEN, tail.length);
  Atomics.store(b.ctrl, at + S_STATUS, ST_PENDING);
  ping(b);
  return { slot, gen };
}

/** Whether the answer has landed. Never blocks. */
export function isDone(b: Bridge, t: Ticket): boolean {
  const at = slotAt(t.slot);
  // An expired ticket counts as done: there is nothing left to wait for.
  if (Atomics.load(b.ctrl, at + S_GEN) !== t.gen) return true;
  return Atomics.load(b.ctrl, at + S_STATUS) === ST_READY;
}

/**
 * Park until any of these has an answer, and say which.
 *
 * The wait is on `DONE_SEQ` rather than on a slot, because `Atomics.wait` takes one
 * address: every completion bumps that counter and the waiter rescans. This is also what
 * `poll` over sockets is — submit a `recv` on each and wait for whichever speaks first.
 */
export function waitAny(b: Bridge, tickets: Ticket[]): Ticket | null {
  if (tickets.length === 0) return null;
  for (;;) {
    const seen = Atomics.load(b.ctrl, DONE_SEQ);
    for (const t of tickets) if (isDone(b, t)) return t;
    parkForHost(b, seen);
  }
}

/**
 * Wait for this call and take its answer, freeing the slot.
 *
 * A response too large for the slot arrives in pieces: the host says `STATUS_MORE`, we take
 * what is there and ask again with `OP_CONTINUE`.
 */
export function collect(b: Bridge, t: Ticket): Uint8Array {
  const at = slotAt(t.slot);
  if (Atomics.load(b.ctrl, at + S_GEN) !== t.gen) {
    throw new HostCallError("this call was already collected or cancelled");
  }
  const parts: Uint8Array[] = [];
  for (;;) {
    awaitReady(b, t.slot);
    const status = Atomics.load(b.ctrl, at + S_RES_STATUS);
    const len = Atomics.load(b.ctrl, at + S_RES_LEN);
    const chunk = b.res(t.slot).slice(0, len);   // a copy: the slot gets reused
    if (status === STATUS_ERR) {
      release(b, t.slot);
      throw new HostCallError(dec.decode(chunk));
    }
    parts.push(chunk);
    if (status !== STATUS_MORE) break;
    Atomics.store(b.ctrl, at + S_OP, OP_CONTINUE);
    Atomics.store(b.ctrl, at + S_REQ_LEN, 0);
    Atomics.store(b.ctrl, at + S_STATUS, ST_PENDING);
    ping(b);
  }
  release(b, t.slot);

  if (parts.length === 1) return parts[0];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let into = 0;
  for (const p of parts) { out.set(p, into); into += p.length; }
  return out;
}

/**
 * Stop caring about a call.
 *
 * **Detach, not abort.** The host may already be inside the work and cannot generally be
 * interrupted; only where the underlying API takes an `AbortSignal` does anything actually
 * stop. What this guarantees is that the answer is discarded and the slot comes back,
 * which is what a caller that has given up needs.
 */
export function cancel(b: Bridge, t: Ticket): void {
  const at = slotAt(t.slot);
  if (Atomics.load(b.ctrl, at + S_GEN) !== t.gen) return;             // already gone
  if (Atomics.load(b.ctrl, at + S_STATUS) === ST_READY) { release(b, t.slot); return; }
  // The host frees it when the work lands. The generation moves now, so the ticket is dead
  // from this side immediately.
  Atomics.add(b.ctrl, at + S_GEN, 1);
  Atomics.store(b.ctrl, at + S_STATUS, ST_CANCELLED);
  ping(b);
}

/** Submit and collect, which is what a capability with no reason to overlap does. */
export function hostCall(b: Bridge, op: number, payload: Uint8Array): Uint8Array {
  return collect(b, submit(b, op, payload));
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
