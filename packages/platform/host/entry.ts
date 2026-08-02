// The entry point of a bundled application: one file that is both the launcher and the
// worker it launches.
//
// A self-contained executable cannot reference a sibling `worker.ts`, so the bundle spawns
// *itself* — `new Worker(import.meta.url)` re-runs the same file, which notices it is on a
// worker and runs the application instead of launching one. A shebang does not get in the
// way; that was checked rather than assumed.
//
// Detection is `WorkerGlobalScope`, not `import.meta.main`, which is **true in both** — a
// distinction that would have failed silently, since the bundle would have launched a
// launcher rather than an application.

import { bridgeOf, newBridge } from "./layout.ts";
import { serveHostCalls } from "./respond.ts";
import { denoWorld } from "./deno.ts";
import { cliOf, coreOf } from "./provider.ts";

/**
 * The generated module of an application.
 *
 * `main(Core, Cli) -> i32` is the whole contract. It was a struct with `start` and `run`
 * first, which bought nothing: a program that runs once and exits has no state to keep
 * between calls, so the struct was ceremony around a function. A *service*, called
 * repeatedly, will want the struct — and can have it then.
 */
export type AppModule = {
  Core: { of(...a: unknown[]): unknown };
  Cli: { of(...a: unknown[]): unknown };
  FileResult: { of(...a: unknown[]): unknown };
  main: (core: unknown, cli: unknown) => number;
};

type Start = { sab: SharedArrayBuffer };
type Result = { ok: true; code: number } | { ok: false; error: string };

const onWorker = (): boolean =>
  typeof (globalThis as Record<string, unknown>).WorkerGlobalScope !== "undefined";

// ── The handler is installed on import, not inside `runBundled` ───────────────
// The module bindgen generates has a top-level `await WebAssembly.instantiate`, so a
// worker's evaluation *suspends* there — and a `postMessage` arriving in that window is
// dropped, leaving the launcher waiting for a reply that never comes.
//
// `packages/stream` documents this exact hazard and it still caught this file out, because
// the offending await is in an imported module rather than in this one. It showed up as a
// binary that worked one run in three, which is the worst way to be told.
//
// So the handler goes in at module scope, and the generated entry imports this module
// *before* the application: this side effect runs first and buffers whatever arrives while
// the application is still starting.
let buffered: Start | null = null;
let deliver: ((s: Start) => void) | null = null;

if (onWorker()) {
  (self as unknown as { onmessage: ((e: MessageEvent) => void) | null }).onmessage = (e) => {
    const s = e.data as Start;
    if (deliver !== null) deliver(s);
    else buffered = s;
  };
}

function firstMessage(): Promise<Start> {
  if (buffered !== null) return Promise.resolve(buffered);
  return new Promise<Start>((res) => { deliver = res; });
}

/**
 * What the build granted this application. Baked in, not parsed from the command line.
 *
 * A built program should look like any other program: `./wc README.md`, not
 * `./wc --allow-read -- README.md`. Deciding at build is also the more honest place —
 * whoever packages the thing chooses what it may do, and the person running it cannot
 * quietly widen that.
 */
export type Grants = { read?: boolean; write?: boolean; env?: boolean };

/**
 * Run a bundled application. Called by the generated entry with its own module.
 *
 * On the main thread this serves the capabilities the build granted, spawns the worker
 * and exits with the application's code. On a worker it builds the capability structs
 * and runs the application. Every argument goes to the application; the launcher takes
 * none of its own.
 */
export async function runBundled(app: AppModule, grants: Grants = {}): Promise<void> {
  if (onWorker()) return runAsWorker(app);
  await runAsLauncher(grants);
}

async function runAsWorker(app: AppModule): Promise<void> {
  const worker = self as unknown as { postMessage(m: Result): void };
  const start = await firstMessage();
  {
    {
      const b = bridgeOf(start.sab);
      try {
        if (typeof app.main !== "function") {
          throw new Error("an application must export `main(Core, Cli) -> i32`");
        }
        worker.postMessage({ ok: true, code: app.main(coreOf(b, app), cliOf(b, app)) });
      } catch (err) {
        worker.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}

async function runAsLauncher(grants: Grants): Promise<void> {
  const bridge = newBridge();
  const responder = serveHostCalls(bridge, denoWorld({
    args: [...Deno.args],
    fs: { read: grants.read === true, write: grants.write === true },
    env: grants.env === true ? (n) => Deno.env.get(n) : undefined,
  }));

  const worker = new Worker(import.meta.url, { type: "module" });
  const finished = new Promise<number>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as Result;
      if (m.ok) resolve(m.code);
      else reject(new Error(m.error));
    };
    worker.onerror = (e) => reject(new Error(e.message));
  });
  worker.postMessage({ sab: bridge.sab });

  try {
    Deno.exit(await finished);
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    Deno.exit(70);
  } finally {
    responder.stop();
    worker.terminate();
  }
}
