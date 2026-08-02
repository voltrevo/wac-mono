// The bridge's ring, from a real worker.
//
// The rest of the suite drives the bridge through wac programs, which today issue one call
// at a time — so nothing there would notice if the ring served them strictly in order and
// the slots were decoration. These tests use the worker API directly and check the
// properties the ring exists for: submitting does not block, several calls overlap, the
// answers do not have to come back in order, and a ticket cannot be confused with the one
// that reused its slot.

import { newBridge } from "../host/layout.ts";
import { serveHostCalls } from "../host/respond.ts";

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

/**
 * Run a snippet on a worker with the bridge attached, and return what it posts back.
 *
 * The worker imports `call.ts` directly: this is a test of that module, not of the
 * capability world above it.
 */
async function onWorker(body: string, handlers: Record<number, (p: Uint8Array) => Uint8Array | Promise<Uint8Array>>): Promise<unknown> {
  const bridge = newBridge();
  const responder = serveHostCalls(bridge, handlers);
  const src = `
    import { submit, collect, isDone, waitAny, cancel, hostCall, i32le, readI32le } from ${JSON.stringify(CALL)};
    import { bridgeOf } from ${JSON.stringify(import.meta.resolve("../host/layout.ts"))};
    self.onmessage = (e) => {
      const b = bridgeOf(e.data);
      try { self.postMessage({ ok: true, value: (() => { ${body} })() }); }
      catch (err) { self.postMessage({ ok: false, error: String(err && err.message || err) }); }
    };
  `;
  const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  const w = new Worker(url, { type: "module" });
  try {
    const r = await new Promise<{ ok: boolean; value?: unknown; error?: string }>((res) => {
      w.onmessage = (e) => res(e.data);
      w.postMessage(bridge.sab);
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  } finally {
    w.terminate();
    responder.stop();
    await responder.done;
    URL.revokeObjectURL(url);
  }
}

/** A capability that takes as long as its payload says, then answers with that number. */
const SLOW = 1;
const slowHandlers = {
  [SLOW]: async (p: Uint8Array) => {
    const ms = new DataView(p.buffer, p.byteOffset, p.byteLength).getInt32(0, true);
    await new Promise((r) => setTimeout(r, ms));
    return p;
  },
};

Deno.test("submitting does not block, and calls overlap", async () => {
  // Three calls of 120ms each. Serially that is 360ms; overlapped it is a little over 120.
  // The threshold is deliberately loose — this is a claim about concurrency, not a
  // benchmark, and a tight bound would be flaky on a busy machine.
  const out = await onWorker(
    `
      const t0 = Date.now();
      const a = submit(b, ${SLOW}, i32le(120));
      const c = submit(b, ${SLOW}, i32le(120));
      const d = submit(b, ${SLOW}, i32le(120));
      const submitMs = Date.now() - t0;
      const anyDone = isDone(b, a) || isDone(b, c) || isDone(b, d);
      const vals = [collect(b, a), collect(b, c), collect(b, d)].map((r) => readI32le(r));
      return { submitMs, anyDone, vals: vals.join(","), totalMs: Date.now() - t0 };
    `,
    slowHandlers,
  ) as { submitMs: number; anyDone: boolean; vals: string; totalMs: number };

  assertEquals(out.submitMs < 50, true, `submitting blocked for ${out.submitMs}ms`);
  assertEquals(out.anyDone, false, "nothing can be done immediately after submitting");
  assertEquals(out.vals, "120,120,120", "each ticket got its own answer");
  assertEquals(out.totalMs < 300, true, `took ${out.totalMs}ms; serial would be ~360`);
});

Deno.test("waitAny returns whichever finishes first, whatever the order they were sent", async () => {
  // Submitted slowest first. If completion were ordered by submission this would come back
  // 300,200,100 — the check is that it does not.
  const out = await onWorker(
    `
      const slow = submit(b, ${SLOW}, i32le(300));
      const mid = submit(b, ${SLOW}, i32le(200));
      const fast = submit(b, ${SLOW}, i32le(100));
      const order = [];
      const left = [slow, mid, fast];
      while (left.length > 0) {
        const t = waitAny(b, left);
        left.splice(left.indexOf(t), 1);
        order.push(readI32le(collect(b, t)));
      }
      return order.join(",");
    `,
    slowHandlers,
  );
  assertEquals(out, "100,200,300", "completions came back in submission order, not by speed");
});

Deno.test("a ticket cannot be confused with the call that reused its slot", async () => {
  // Four slots, so the fifth call must reuse one. Collecting a spent ticket has to say so
  // rather than hand back whatever now occupies that slot — which would look plausible and
  // be wrong, the worst combination.
  const out = await onWorker(
    `
      const first = submit(b, ${SLOW}, i32le(1));
      collect(b, first);
      let reused = "no error";
      try { collect(b, first); } catch (e) { reused = "refused"; }

      // Five in a row through four slots: the fifth waits for one to free rather than
      // failing, and every answer is still its own.
      const vals = [];
      for (let i = 0; i < 5; i++) vals.push(readI32le(collect(b, submit(b, ${SLOW}, i32le(i + 1)))));
      return { reused, vals: vals.join(",") };
    `,
    slowHandlers,
  ) as { reused: string; vals: string };
  assertEquals(out.reused, "refused", "a spent ticket was collected twice");
  assertEquals(out.vals, "1,2,3,4,5");
});

Deno.test("cancel frees the slot and the answer is discarded", async () => {
  // Cancel is detach, not abort: the host may already be inside the work. What it
  // guarantees is that the slot comes back and the result is dropped — so four cancels
  // through four slots must not exhaust the ring.
  const out = await onWorker(
    `
      const t0 = Date.now();
      for (let i = 0; i < 8; i++) cancel(b, submit(b, ${SLOW}, i32le(80)));
      const cancelMs = Date.now() - t0;
      // The ring still works afterwards.
      const after = readI32le(hostCall(b, ${SLOW}, i32le(1)));
      return { cancelMs, after };
    `,
    slowHandlers,
  ) as { cancelMs: number; after: number };
  assertEquals(out.after, 1, "the bridge still works after cancels");
  // Eight cancels through four slots: some waited for a slot, none waited for all the work.
  assertEquals(out.cancelMs < 400, true, `cancelling took ${out.cancelMs}ms`);
});

Deno.test("an error in one slot does not disturb the others", async () => {
  const BOOM = 2;
  const out = await onWorker(
    `
      const good = submit(b, ${SLOW}, i32le(60));
      const bad = submit(b, ${BOOM}, i32le(0));
      let msg = "none";
      try { collect(b, bad); } catch (e) { msg = e.message; }
      return { msg, good: readI32le(collect(b, good)) };
    `,
    { ...slowHandlers, [BOOM]: () => { throw new Error("deliberate"); } },
  ) as { msg: string; good: number };
  assertEquals(out.msg, "deliberate", "the failure reached the caller");
  assertEquals(out.good, 60, "and the other call was unaffected");
});
