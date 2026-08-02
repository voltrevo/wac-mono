// The two halves of a built program, in a page.
//
// Same bridge, same opcodes, same capability structs. What differs from Deno and Node is
// smaller than it looks: the worker is a web `Worker` from a blob URL, and the page checks
// `crossOriginIsolated` before doing anything, because without it `SharedArrayBuffer` is
// not constructible and the failure would otherwise be a bare TypeError from `newBridge`.
//
// The worker half is unchanged in shape from Deno's: a message brings the buffer, the
// application runs to completion on a thread that is allowed to block, and the result goes
// back. `Atomics.wait` throws on a page's main thread, which is exactly why the split
// exists and why the page must not be the one running wac.

import { bridgeOf, newBridge } from "./layout.ts";
import { serveHostCalls } from "./respond.ts";
import { browserWorld, type BrowserWorldOptions } from "./browser.ts";
import { cliOf, coreOf } from "./provider.ts";
import type { AppModule } from "./entry.ts";

type Start = { sab: SharedArrayBuffer };
type Result = { ok: true; code: number } | { ok: false; error: string };

/**
 * The worker half. Call this at module scope, before awaiting anything.
 *
 * The handler has to be installed synchronously: a generated program suspends at its own
 * top-level `await WebAssembly.instantiate`, and a `postMessage` that arrives during that
 * suspension is dropped. `packages/stream`'s README records the same trap, and the Deno
 * launcher was bitten by it once — it worked one run in three.
 */
export function runAsWorkerBrowser(load: () => Promise<AppModule>): void {
  // `self` is a worker scope here, which Deno's default library does not know while
  // type-checking this file — the same cast `entry.ts` makes, for the same reason.
  const scope = self as unknown as {
    onmessage: ((e: MessageEvent) => void) | null;
    postMessage(m: Result): void;
  };
  scope.onmessage = (ev: MessageEvent) => {
    const start = ev.data as Start;
    void (async () => {
      const b = bridgeOf(start.sab);
      try {
        const app = await load();
        scope.postMessage({ ok: true, code: app.main(coreOf(b, app), cliOf(b, app)) });
      } catch (e) {
        scope.postMessage({
          ok: false,
          error: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e),
        });
      }
    })();
  };
}

/** What a page needs to say about the environment it is offering. */
export type PageOptions = BrowserWorldOptions & {
  /** The worker's source. The build inlines the whole program here. */
  workerSource: string;
};

/**
 * The launcher half: serve capabilities on the page's thread, run the worker, resolve with
 * the application's exit code.
 *
 * Never blocks. `serveHostCalls` waits with `Atomics.waitAsync`, so the event loop keeps
 * turning and the asynchronous work a capability needs — an OPFS read, say — can actually
 * happen while the worker is parked waiting for it.
 */
export async function runInPage(opts: PageOptions): Promise<number> {
  // Another one Deno's library does not declare, because it is a page property.
  const isolated = (globalThis as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated;
  if (isolated !== true) {
    throw new Error(
      "this page is not cross-origin isolated, so SharedArrayBuffer is unavailable — " +
        "serve it with Cross-Origin-Opener-Policy: same-origin and " +
        "Cross-Origin-Embedder-Policy: require-corp",
    );
  }

  const bridge = newBridge();
  const responder = serveHostCalls(bridge, browserWorld(opts));

  const url = URL.createObjectURL(new Blob([opts.workerSource], { type: "text/javascript" }));
  const worker = new Worker(url, { type: "module" });
  try {
    const code = await new Promise<number>((resolve, reject) => {
      worker.addEventListener("message", (ev: MessageEvent) => {
        const r = ev.data as Result;
        if (r.ok) resolve(r.code);
        else reject(new Error(r.error));
      });
      worker.addEventListener("error", (e: ErrorEvent) => reject(new Error(e.message)));
      worker.postMessage({ sab: bridge.sab } as Start);
    });
    return code;
  } finally {
    responder.stop();
    worker.terminate();
    URL.revokeObjectURL(url);
  }
}

/** Arguments from the query string: `?a=one&a=two` becomes `["one", "two"]`. */
export function argsFromLocation(search: string): string[] {
  return new URLSearchParams(search).getAll("a");
}
