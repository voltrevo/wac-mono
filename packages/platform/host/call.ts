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
  acquireBuf,
  SLOT_INTS,
  BUF_BYTES,
  releaseBuf,
  attach,
  attached,
  detach,
  S_REQ_BUF,
  S_RES_BUF,
  SLOTS,
  slotAt,
  ST_CANCELLED,
  ST_CLAIMED,
  ST_FREE,
  ST_RUNNING,
  ST_PENDING,
  ST_READY,
  STATUS_ERR,
  STATUS_MORE,
  SUBMIT_SEQ,
} from "./layout.ts";
import { OP } from "./ops.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Raised when a capability reports failure. The message is the host's. */
/**
 * A capability that failed, with the *category* of the failure beside its message.
 *
 * The category travels because the message cannot be branched on: "No such file or directory (os error
 * 2)" from Deno, "ENOENT: no such file or directory" from Node and `NotFoundError` from OPFS are three
 * spellings of one fact, and a program that wants to say what GNU says about a missing file had to
 * either parse English or print the host's sentence. The mutating side of the world has had a category
 * since `Change` existed; this is the same one, for everything that fails. wac-mono 0062.
 *
 * `FAULT_OTHER` when the host said nothing a classifier could use, which is what an unclassified error
 * has always meant.
 */
export class HostCallError extends Error {
  readonly fault: number;
  constructor(message: string, fault = 5) {
    super(message);
    this.fault = fault;
  }
}

/** Split an error payload into its category byte and its message. */
export function faultedMessage(bytes: Uint8Array): { fault: number; message: string } {
  if (bytes.length === 0) return { fault: 5, message: "" };
  return { fault: bytes[0], message: new TextDecoder().decode(bytes.subarray(1)) };
}

/**
 * What a slot's opcode was, for diagnostics only.
 *
 * Worth the table: the mistake that fills the ring happens several calls before the error, so
 * naming what is *holding* the slots is most of the way to which line was wrong.
 */
const OP_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(OP).map(([name, op]) => [op, name]),
);
export const opName = (op: number): string =>
  op === OP_CONTINUE ? "a continued response" : (OP_NAMES[op] ?? `op ${op}`);

/**
 * A call in flight.
 *
 * The generation is not decoration: slots are reused, and waiting on a ticket whose slot
 * had been recycled would read whatever call now occupies it — which is the worst kind of
 * bug, because the answer looks plausible.
 */
export type Ticket = { slot: number; gen: number };

/**
 * What every slot in a bridge is doing, for a caller narrating a stall.
 *
 * wac-mono 0082: a child that never finishes leaves the parent with nothing to say beyond "it is still
 * running". The slot table is the answer — a worker blocked in a host call has a slot sitting at
 * `pending` with its opcode in it, and a worker blocked on something else has none.
 *
 * Reads only, and atomically, so it is safe to call at any moment from either side. Never used to decide
 * anything: it prints.
 */
export function describeSlots(b: Bridge): string {
  // Indexed by the constant's *value*, not by the order they happen to be declared in: `ST_CLAIMED` is
  // 5, not 1, and a table written from the declaration order labelled `ST_RUNNING` as "pending". That is
  // not cosmetic — it inverts the diagnosis, since "pending" means the host has not taken the slot and
  // "running" means it has and the handler never came back. wac-mono 0082 was read backwards for an hour
  // on the strength of it.
  const names: Record<number, string> = {
    [ST_FREE]: "free",
    [ST_PENDING]: "pending",
    [ST_RUNNING]: "running",
    [ST_READY]: "ready",
    [ST_CANCELLED]: "cancelled",
    [ST_CLAIMED]: "claimed",
  };
  const busy: string[] = [];
  for (let i = 0; i < SLOTS; i++) {
    const at = slotAt(i);
    const st = Atomics.load(b.ctrl, at + S_STATUS);
    if (st === ST_FREE) continue;
    const op = Atomics.load(b.ctrl, at + S_OP);
    // The handle for the stream operations, because `RECV` on standard input and `RECV` on a spawned
    // child's output are different waits with different causes, and the opcode alone cannot tell them
    // apart. Handle 0 is standard input; anything else counts from 1.
    // The handle, when the request payload is still attached: the host detaches the buffer as it takes
    // the call, so a slot in `running` no longer has one to read. That is the common case in a stall
    // report, and it is why this is a `?` rather than a lookup.
    const rb = attached(b, at, S_REQ_BUF);
    const handle = (op === OP.RECV || op === OP.SEND) && rb >= 0 &&
        Atomics.load(b.ctrl, at + S_REQ_LEN) >= 4
      ? `(h=${new DataView(b.reqBuf(rb).buffer, b.reqBuf(rb).byteOffset, 4).getInt32(0, true)})`
      : "";
    busy.push(`${i}:${names[st] ?? st}:${opName(op)}${handle}`);
  }
  return busy.length === 0
    ? `no slot in use (submit=${Atomics.load(b.ctrl, SUBMIT_SEQ)} done=${Atomics.load(b.ctrl, DONE_SEQ)})`
    : `${busy.join(" ")} (submit=${Atomics.load(b.ctrl, SUBMIT_SEQ)} done=${
      Atomics.load(b.ctrl, DONE_SEQ)
    })`;
}

/**
 * Take a request buffer, waiting for one if the pool is empty.
 *
 * Waiting is safe here and only here: a request buffer is released by the **host** as it takes the call,
 * so a worker parked for one is waiting on the other side, which makes progress on its own. That is the
 * whole reason there are two pools — with one, this wait could be on a buffer only this thread can free.
 */
function takeReqBuf(b: Bridge): number {
  for (;;) {
    const seen = Atomics.load(b.ctrl, DONE_SEQ);
    const i = acquireBuf(b, "req");
    if (i >= 0) return i;
    parkForHost(b, seen);
  }
}

/** Publish a slot's state change and wake the host. */
function ping(b: Bridge): void {
  Atomics.add(b.ctrl, SUBMIT_SEQ, 1);
  Atomics.notify(b.ctrl, SUBMIT_SEQ);
}

/** Park until the host changes something, then look again. */
function parkForHost(b: Bridge, seen: number, millis = Infinity): void {
  Atomics.wait(b.ctrl, DONE_SEQ, seen, millis);
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
      // Claimed rather than pending: `submit` publishes it as pending once the opcode and
      // payload are in, and until then the host must not take it.
      if (Atomics.compareExchange(b.ctrl, at + S_STATUS, ST_FREE, ST_CLAIMED) === ST_FREE) {
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
    // 0018 was filed about. `waitAny` says which ticket settled and collects nothing, so a
    // ticket that lost and was then forgotten keeps its slot for good.
    if (ready === SLOTS) {
      // Tallied rather than listed: 128 opcodes in a row is a wall of text, and what the reader needs is
      // which *kind* of call was abandoned — `RECV × 126` says the mistake at a glance.
      const tally = new Map<string, number>();
      for (let i = 0; i < SLOTS; i++) {
        const name = opName(Atomics.load(b.ctrl, slotAt(i) + S_OP));
        tally.set(name, (tally.get(name) ?? 0) + 1);
      }
      const held = [...tally].sort((x, y) => y[1] - x[1]).map(([n, c]) => c === 1 ? n : `${n} × ${c}`);
      throw new HostCallError(
        `all ${SLOTS} call slots hold answers that were never taken, from: ${held.join(", ")}. ` +
          `A ticket you stopped waiting on has to be wait()ed or cancel()led — waitAny reports ` +
          `which one settled and collects nothing, so the others keep their slots. The call ` +
          `that failed here is only the first one to find the ring full; the abandoned ticket ` +
          `is usually earlier.`,
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

/**
 * The answer bytes, copied out, with the buffer handed straight back.
 *
 * The copy is not new — the slot was always reused under the reader — but the release is: a response
 * buffer is the scarce thing now, and holding one a moment longer than the copy is memory somebody else
 * is parked on.
 */
/** Which slot a control offset belongs to — the inline area is indexed by slot, not by buffer. */
function slotOf(at: number): number {
  return (at - slotAt(0)) / SLOT_INTS;
}

function readRes(b: Bridge, at: number): Uint8Array {
  const len = Atomics.load(b.ctrl, at + S_RES_LEN);
  const bi = attached(b, at, S_RES_BUF);
  // `-1` means the answer is inline rather than absent: small answers never take a pooled buffer, and an
  // answer that could not get one is written inline in pieces.
  const out = (bi < 0 ? b.inline(slotOf(at)) : b.resBuf(bi)).slice(0, len);
  detach(b, at, S_RES_BUF);
  releaseBuf(b, "res", bi);
  // The host may be holding an answer it could not write for want of a buffer; this is what tells it.
  ping(b);
  return out;
}

/** Give the slot back and move its generation on, so stale tickets read as expired. */
function release(b: Bridge, slot: number): void {
  const at = slotAt(slot);
  // The answer's buffer goes back here too, whatever route got us here. Doing it only in `readRes` left
  // two paths leaking one buffer each — an acknowledged push chunk, and a cancel of a call that had
  // already answered — and a pool that loses one buffer per occurrence is a hang later with nothing to
  // point at. `releaseBuf` ignores -1, so a slot whose answer was already read is unaffected.
  releaseBuf(b, "res", detach(b, at, S_RES_BUF));
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

  let sent = 0;
  while (payload.length - sent > BUF_BYTES) {
    // A buffer per piece, released by the host as it reads each one. Holding one across the whole push
    // loop would pin it for the length of a multi-megabyte write, which is the memory this pool exists to
    // stop being reserved.
    const bi = takeReqBuf(b);
    b.reqBuf(bi).set(payload.subarray(sent, sent + BUF_BYTES), 0);
    attach(b, at, S_REQ_BUF, bi);
    Atomics.store(b.ctrl, at + S_OP, OP_PUSH);
    Atomics.store(b.ctrl, at + S_REQ_LEN, BUF_BYTES);
    Atomics.store(b.ctrl, at + S_STATUS, ST_PENDING);
    ping(b);
    awaitReady(b, slot);
    // Read *before* the check, because reading is what hands the buffer back: an acknowledgement carries
    // no bytes but it does carry a buffer, and skipping it leaked one per chunk of every large write.
    const acked = readRes(b, at);
    if (Atomics.load(b.ctrl, at + S_RES_STATUS) === STATUS_ERR) {
      const said = faultedMessage(acked);
      release(b, slot);
      throw new HostCallError(said.message, said.fault);
    }
    sent += BUF_BYTES;   // acknowledged; the host is waiting for the next piece
  }

  const tail = payload.subarray(sent);
  const bi = takeReqBuf(b);
  b.reqBuf(bi).set(tail, 0);
  attach(b, at, S_REQ_BUF, bi);
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
export function waitAny(b: Bridge, tickets: Ticket[], millis = -1): Ticket | null {
  if (tickets.length === 0) return null;
  // `Atomics.wait` takes a timeout, so a deadline needs nothing from the host: no opcode, no
  // slot, and nothing to clean up afterwards. A timer *ticket* would need all three, and the
  // ticket nobody remembers to cancel is how the ring fills up.
  const deadline = millis < 0 ? Infinity : performance.now() + millis;
  for (;;) {
    const seen = Atomics.load(b.ctrl, DONE_SEQ);
    for (const t of tickets) if (isDone(b, t)) return t;
    // Checked after the scan, so a deadline of 0 is a poll of the set rather than a wait that
    // always fails, and an already-settled ticket is reported even when the time is up.
    const left = deadline - performance.now();
    if (left <= 0) return null;
    parkForHost(b, seen, left);
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
    const chunk = readRes(b, at);   // copied out, and the pooled buffer handed back at once
    if (status === STATUS_ERR) {
      release(b, t.slot);
      const said = faultedMessage(chunk);
      throw new HostCallError(said.message, said.fault);
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

/**
 * An argument as bytes, whichever shape the host was given.
 *
 * A launcher has strings — `Deno.args` is text by the time the runtime hands it over — and a *parent*
 * spawning a child has the exact bytes. Both are accepted, and only the string is encoded, so nothing that
 * arrived as bytes is round-tripped through UTF-8. wac-mono 0065.
 */
export const argBytes = (a: string | Uint8Array): Uint8Array =>
  typeof a === "string" ? enc.encode(a) : a;

/** An empty argument, for an index nobody passed. */
export const EMPTY_ARG = new Uint8Array(0);
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
