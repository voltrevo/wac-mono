// A request buffer comes back, whatever ends the call.
//
// The request pool is the one a worker *waits* on: `takeReqBuf` parks until one is free, which is safe
// only because the host frees them as it takes each call. Every path that ends a call without the host
// taking it therefore has to hand the buffer back, and a path that forgets does not fail — it removes one
// of eight buffers for the life of the process, and the failure lands later, in an unrelated call, as a
// park with nothing to point at. That is the shape this exists to catch.

import { attached, BUF_BYTES, BUFS, newBridge, REQ_FREE_AT, S_REQ_BUF, SLOTS, slotAt } from "../host/layout.ts";
import { serveHostCalls } from "../host/respond.ts";
import { newScheduler } from "../host/schedule.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

const CALL = import.meta.resolve("../host/call.ts");
const LAYOUT = import.meta.resolve("../host/layout.ts");

/** How many request buffers are on the free list. */
function reqFree(b: ReturnType<typeof newBridge>): number {
  let n = 0;
  for (let i = 0; i < BUFS; i++) if (Atomics.load(b.ctrl, REQ_FREE_AT + i) === 0) n++;
  return n;
}

/** Any slot still holding a request buffer, as `slot:buffer`. */
function stillAttached(b: ReturnType<typeof newBridge>): string[] {
  const held: string[] = [];
  for (let s = 0; s < SLOTS; s++) {
    const i = attached(b, slotAt(s), S_REQ_BUF);
    if (i >= 0) held.push(`${s}:${i}`);
  }
  return held;
}

/** Run `body` in a worker against this bridge and return what it posts back. */
function onWorker(b: ReturnType<typeof newBridge>, body: string): { said: Promise<string>; stop: () => void } {
  const src = `
    import { submit, collect, cancel, hostCall } from ${JSON.stringify(CALL)};
    import { bridgeOf } from ${JSON.stringify(LAYOUT)};
    self.onmessage = (e) => {
      const b = bridgeOf(e.data);
      try { self.postMessage(String(${body})); }
      catch (err) { self.postMessage("raised: " + ((err && err.message) || err)); }
    };
  `;
  const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  const w = new Worker(url, { type: "module" });
  const said = new Promise<string>((res) => {
    w.onmessage = (e) => res(e.data as string);
    w.postMessage(b.sab);
  });
  return { said, stop: () => { w.terminate(); URL.revokeObjectURL(url); } };
}

Deno.test("a call the host answers without taking still gives its buffer back", async () => {
  // The shutdown path: `failPending` answers every slot still holding a request so a parked worker learns
  // rather than waits — but it answers *without* taking, so the request buffer is still attached to the
  // slot. If nothing detaches it, that buffer is gone. A host that restarts its responder — every test
  // that builds a second bridge in one process — would run out after eight.
  const b = newBridge();
  assertEquals(reqFree(b), BUFS, "a fresh bridge has every request buffer free");

  // A handler that never answers, so the call is outstanding when the responder stops.
  const responder = serveHostCalls(b, { 1: () => new Promise<Uint8Array>(() => {}) }, {
    scheduler: newScheduler("off"),
  });

  // Big enough to push in pieces: the push loop holds a request buffer per chunk, and the last piece is
  // still attached when the handler is called.
  const worker = onWorker(b, `(() => { collect(b, submit(b, 1, new Uint8Array(${BUF_BYTES} + 16))); return "answered"; })()`);
  try {
    // Let the call reach the handler, then stop the responder under it.
    await new Promise((r) => setTimeout(r, 200));
    await responder.stop();
    const said = await Promise.race([
      worker.said,
      new Promise<string>((r) => setTimeout(() => r("still parked"), 4000)),
    ]);
    assertEquals(said.startsWith("raised:"), true, `the worker should have been told the host stopped: ${said}`);
    assertEquals(
      stillAttached(b).length,
      0,
      `a slot still holds a request buffer: ${stillAttached(b).join(" ")}`,
    );
    assertEquals(reqFree(b), BUFS, "every request buffer is back on the free list");
  } finally {
    worker.stop();
  }
});

Deno.test("a call the host never even took gives its buffer back", async () => {
  // The case the shutdown path really has to cover: the slot is still *pending* — the host never read it,
  // so the request buffer is attached and nothing else will ever detach it. Made deterministic with a
  // responder whose signal is already aborted, so its loop never sweeps: exactly the state a responder
  // that stops between a worker's publish and the next sweep leaves behind.
  const b = newBridge();
  const aborted = new AbortController();
  aborted.abort();
  const responder = serveHostCalls(b, { 1: () => Promise.resolve(new Uint8Array(0)) }, {
    scheduler: newScheduler("off"),
    signal: aborted.signal,
  });
  const worker = onWorker(b, `(() => { collect(b, submit(b, 1, new Uint8Array(64))); return "answered"; })()`);
  try {
    await new Promise((r) => setTimeout(r, 150));
    assertEquals(reqFree(b), BUFS - 1, "the worker is holding the request buffer it published with");
    responder.stop();
    const said = await Promise.race([
      worker.said,
      new Promise<string>((r) => setTimeout(() => r("still parked"), 4000)),
    ]);
    assertEquals(said.startsWith("raised:"), true, `the worker should have been told: ${said}`);
    assertEquals(stillAttached(b).length, 0, `still attached: ${stillAttached(b).join(" ")}`);
    assertEquals(reqFree(b), BUFS, "the request buffer of a call nobody read is back");
  } finally {
    worker.stop();
  }
});

Deno.test("a cancelled call gives its request buffer back too", async () => {
  const b = newBridge();
  const responder = serveHostCalls(b, { 1: () => new Promise<Uint8Array>(() => {}) }, {
    scheduler: newScheduler("off"),
  });
  const worker = onWorker(
    b,
    `(() => {
       const t = submit(b, 1, new Uint8Array(64));
       cancel(b, t);
       return "cancelled";
     })()`,
  );
  try {
    assertEquals(await worker.said, "cancelled");
    // The sweep hands a cancelled slot back; give it a moment to run.
    await new Promise((r) => setTimeout(r, 200));
    assertEquals(
      stillAttached(b).length,
      0,
      `a cancelled slot still holds a request buffer: ${stillAttached(b).join(" ")}`,
    );
    assertEquals(reqFree(b), BUFS, "every request buffer is back after a cancel");
  } finally {
    await responder.stop();
    worker.stop();
  }
});

Deno.test("an ordinary call leaves the pool exactly as it found it", async () => {
  const b = newBridge();
  const responder = serveHostCalls(b, { 1: (p: Uint8Array) => Promise.resolve(p.slice(0, 8)) }, {
    scheduler: newScheduler("off"),
  });
  // Several calls, some large enough to chunk, so the push loop's buffer-per-piece is exercised.
  const worker = onWorker(
    b,
    `(() => {
       for (let i = 0; i < 5; i++) hostCall(b, 1, new Uint8Array(${BUF_BYTES} + 1));
       for (let i = 0; i < 5; i++) hostCall(b, 1, new Uint8Array(32));
       return "done";
     })()`,
  );
  try {
    assertEquals(await worker.said, "done");
    assertEquals(reqFree(b), BUFS, "ten calls later, the pool is whole");
    assertEquals(stillAttached(b).length, 0, stillAttached(b).join(" "));
  } finally {
    await responder.stop();
    worker.stop();
  }
});
