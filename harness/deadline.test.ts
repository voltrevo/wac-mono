// The deadline helpers, including the case they exist for: a stream that stays open and says nothing.
//
// Worth testing rather than eyeballing, because a bounded wait that is subtly unbounded looks exactly
// like a working one until the day something hangs — which is how 0036 was written in the first place.

import { readUntil, withDeadline } from "./deadline.ts";

/** Local rather than `@std/assert`: jsr.io is not on this container's proxy allowlist. */
async function assertRejects(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection, got a value");
}

const streamOf = (chunks: string[], keepOpen = false) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      if (!keepOpen) controller.close();
    },
  });

Deno.test("withDeadline passes a value through and does not leak its timer", async () => {
  const got = await withDeadline(Promise.resolve(7), "a number", 5_000);
  if (got !== 7) throw new Error(`got ${got}`);
  // Deno's leak detector fails this test if the 5s timer were still pending on return, so the
  // assertion is the test completing at all.
});

Deno.test("withDeadline reports what it was waiting for", async () => {
  const err = await assertRejects(
    () => withDeadline(new Promise(() => {}), "the server to bind port 4242", 30),
  );
  const msg = String(err);
  if (!msg.includes("the server to bind port 4242")) {
    throw new Error(`the message does not say what was awaited: ${msg}`);
  }
  if (!msg.includes("30ms")) throw new Error(`the message does not say how long: ${msg}`);
});

Deno.test("withDeadline propagates the original rejection, not a timeout", async () => {
  const err = await assertRejects(
    () => withDeadline(Promise.reject(new Error("bind: address in use")), "a port", 5_000),
  );
  if (!String(err).includes("address in use")) throw new Error(`lost the real error: ${err}`);
});

Deno.test("readUntil stops at the marker and returns everything consumed", async () => {
  const seen = await readUntil(
    streamOf(["starting\n", "listening on port 9\n", "ignored"]),
    "listening on port 9",
    "the server",
    5_000,
  );
  if (!seen.includes("starting")) throw new Error(`lost earlier output: ${seen}`);
  if (!seen.includes("listening on port 9")) throw new Error(`missing the marker: ${seen}`);
});

Deno.test("readUntil says the stream ended, and quotes what it saw", async () => {
  const err = await assertRejects(
    () => readUntil(streamOf(["bind failed\n"]), "listening", "the server", 5_000),
  );
  const msg = String(err);
  if (!msg.includes("ended before")) throw new Error(`wrong shape: ${msg}`);
  if (!msg.includes("bind failed")) throw new Error(`did not quote the output: ${msg}`);
});

Deno.test("readUntil bounds a stream that stays open and says nothing", async () => {
  // The case the old loop could not distinguish from "not ready yet", and the reason 0036 exists:
  // the child is alive, so there is no `done`, and it prints nothing, so there is no chunk. Without
  // a deadline this `await` never settles and takes the whole suite with it.
  const err = await assertRejects(
    () => readUntil(streamOf(["starting\n"], true), "listening", "the server", 40),
  );
  const msg = String(err);
  if (!msg.includes("timed out")) throw new Error(`not a timeout: ${msg}`);
  if (!msg.includes("starting")) {
    throw new Error(`a timeout must quote what it did see, or it says nothing useful: ${msg}`);
  }
});

Deno.test("readUntil says so plainly when a silent stream printed nothing at all", async () => {
  const err = await assertRejects(
    () => readUntil(streamOf([], true), "listening", "the server", 40),
  );
  if (!String(err).includes("printed nothing")) {
    throw new Error(`an empty log needs saying, not an empty quote: ${err}`);
  }
});
