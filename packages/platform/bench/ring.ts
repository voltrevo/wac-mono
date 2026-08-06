// What a host call costs, so a change to the transport can be argued about with numbers.
//
// The bridge was rebuilt when slots stopped owning their payload buffers: sixteen slots each reserving
// 128 KiB in both directions is 2 MiB per bridge whether a program calls out once or never, and raising the
// slot count multiplies it. Slots are 32-byte control records now, the payload buffers are pooled, and
// every slot keeps a 256-byte inline area so that an answer can always be written even when the pool is
// empty. That is a good trade only if it is not paid for in throughput, which is what this measures.
//
// Four shapes, because they exercise different parts of it:
//
//   - **small, sequential** — the common case. Answer fits inline, no pooled buffer is touched at all.
//   - **large, sequential** — one pooled buffer, taken and returned per call. Measures the copy.
//   - **large, 8 in flight** — exactly the pool size: every buffer busy, nobody waiting.
//   - **large, 32 in flight** — four times the pool. Answers that cannot get a buffer go inline in
//     256-byte pieces, so this is the cost of the guarantee, and the number to watch if `BUFS` changes.
//
// Run with `deno run -A packages/platform/bench/ring.ts`. Not a test: it prints, and asserts nothing.

import { BUFS, BUF_BYTES, INLINE_BYTES, newBridge, SLOTS, TOTAL_BYTES } from "../host/layout.ts";
import { serveHostCalls } from "../host/respond.ts";
import { newScheduler } from "../host/schedule.ts";

const CALL = import.meta.resolve("../host/call.ts");
const LAYOUT = import.meta.resolve("../host/layout.ts");

/** The one capability: an answer of the size the request asks for. */
const ECHO = 1;

const handlers = {
  [ECHO]: (p: Uint8Array): Promise<Uint8Array> => {
    const size = new DataView(p.buffer, p.byteOffset, p.byteLength).getInt32(0, true);
    return Promise.resolve(new Uint8Array(size));
  },
};

/** One measurement, run in a worker because that is where `Atomics.wait` is allowed. */
async function run(label: string, body: string): Promise<string> {
  const bridge = newBridge();
  // Unscheduled: this measures the transport, and the deterministic scheduler deliberately serialises.
  const responder = serveHostCalls(bridge, handlers, { scheduler: newScheduler("off") });
  const src = `
    import { submit, collect, waitAny, hostCall, i32le } from ${JSON.stringify(CALL)};
    import { bridgeOf } from ${JSON.stringify(LAYOUT)};
    self.onmessage = (e) => {
      const b = bridgeOf(e.data);
      const req = (size) => { const p = new Uint8Array(16); new DataView(p.buffer).setInt32(0, size, true); return p; };
      const t0 = performance.now();
      ${body}
      self.postMessage(performance.now() - t0);
    };
  `;
  const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  const w = new Worker(url, { type: "module" });
  try {
    const ms = await new Promise<number>((res) => {
      w.onmessage = (e) => res(e.data as number);
      w.postMessage(bridge.sab);
    });
    return `${label.padEnd(22)} ${ms.toFixed(0).padStart(6)} ms`;
  } finally {
    w.terminate();
    URL.revokeObjectURL(url);
    await responder.stop();
  }
}

const CALLS = 20_000;
const BIG = 1 << 20;
const BIG_CALLS = 300;

const rows = [
  await run(
    `${CALLS} × 64B`,
    `for (let i = 0; i < ${CALLS}; i++) hostCall(b, ${ECHO}, req(64));`,
  ),
  await run(
    `${BIG_CALLS} × 1MiB`,
    `for (let i = 0; i < ${BIG_CALLS}; i++) hostCall(b, ${ECHO}, req(${BIG}));`,
  ),
  await run(
    `${BIG_CALLS} × 1MiB, 8 live`,
    `const ts = [];
     for (let i = 0; i < ${BIG_CALLS}; i++) {
       ts.push(submit(b, ${ECHO}, req(${BIG})));
       if (ts.length === 8) { for (const t of ts) collect(b, t); ts.length = 0; }
     }
     for (const t of ts) collect(b, t);`,
  ),
  await run(
    `${BIG_CALLS} × 1MiB, 32 live`,
    `const ts = [];
     for (let i = 0; i < ${BIG_CALLS}; i++) {
       ts.push(submit(b, ${ECHO}, req(${BIG})));
       if (ts.length === 32) { for (const t of ts) collect(b, t); ts.length = 0; }
     }
     for (const t of ts) collect(b, t);`,
  ),
];

console.log(
  `slots=${SLOTS} pool=${BUFS}×${BUF_BYTES / 1024}KiB×2 inline=${INLINE_BYTES}B ` +
    `bridge=${(TOTAL_BYTES / 1048576).toFixed(2)}MiB`,
);
for (const r of rows) console.log(r);
