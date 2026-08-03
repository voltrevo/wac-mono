// The worker harness the ring's tests are built from.
//
// Not a `.test.ts`, because two files need it and importing one test file from another would
// register its tests twice — they would run under both names and a failure would be reported
// against the wrong file.

import { newBridge } from "../host/layout.ts";
import { serveHostCalls } from "../host/respond.ts";

const CALL = import.meta.resolve("../host/call.ts");

/**
 * Run a snippet on a worker with the bridge attached, and return what it posts back.
 *
 * The worker imports `call.ts` directly: this is a test of that module, not of the
 * capability world above it.
 */
export async function onWorker(body: string, handlers: Record<number, (p: Uint8Array) => Uint8Array | Promise<Uint8Array>>): Promise<unknown> {
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
export const SLOW = 1;
export const slowHandlers = {
  [SLOW]: async (p: Uint8Array) => {
    const ms = new DataView(p.buffer, p.byteOffset, p.byteLength).getInt32(0, true);
    await new Promise((r) => setTimeout(r, ms));
    return p;
  },
};

