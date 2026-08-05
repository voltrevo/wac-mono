// `ByteQueue`, and the one thing it cannot carry.
//
// Empty is the queue's *end* sentinel: `next` resolves with a zero-length array when the queue has
// ended, and `rest` stops on one. So a zero-length **write** collides with it — and the collision is
// invisible unless somebody is reading as the writes arrive, because a reader that only starts after
// the queue has ended finds the empty chunk buffered in the middle and stops there too.
//
// `packages/sh`'s `true` returns `Output.ok(u8[0]())`, so the shell writes zero bytes and
// `echo one; true; echo two` printed `one` alone through a spawned shell. `push` drops empty writes
// now; nothing is lost, because there is nothing in them.

import { ByteQueue } from "../host/children.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

function eq<T>(got: T, want: T, msg: string): void {
  if (got !== want) throw new Error(`${msg}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
}

Deno.test("ByteQueue: a zero-length write does not end the stream, with a reader waiting", async () => {
  const q = new ByteQueue(1 << 20);
  const reading = q.rest();                      // installs a waiter, which is what exposes it
  await q.push(enc.encode("one\n"));
  await q.push(new Uint8Array(0));               // `true`
  await q.push(enc.encode("two\n"));
  q.end();
  eq(dec.decode(await reading), "one\ntwo\n", "the empty write must be a no-op");
});

Deno.test("ByteQueue: nor when the reader starts after everything is queued", async () => {
  const q = new ByteQueue(1 << 20);
  await q.push(enc.encode("one\n"));
  await q.push(new Uint8Array(0));
  await q.push(enc.encode("two\n"));
  q.end();
  eq(dec.decode(await q.rest()), "one\ntwo\n", "buffered, and still not an end");
});

Deno.test("ByteQueue: end is still end, and a write after it is refused", async () => {
  const q = new ByteQueue(1 << 20);
  await q.push(enc.encode("a"));
  q.end();
  eq(await q.push(enc.encode("b")), false, "a write after end is refused");
  eq(dec.decode(await q.rest()), "a", "and does not arrive");
});

Deno.test("ByteQueue: an empty write on an ended queue is still refused", async () => {
  // The early return for empty must not report success for a queue that has closed: `box yes` stops
  // when a write fails, and a zero-length write reporting true would be a lie about the same thing.
  const q = new ByteQueue(1 << 20);
  q.end();
  eq(await q.push(new Uint8Array(0)), false, "ended beats empty");
});
