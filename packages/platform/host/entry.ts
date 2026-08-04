// The two halves of a bundled application: the launcher, and the worker it launches.
//
// A built program carries the worker's *source* as a string and spawns it from a blob
// URL. The obvious alternative — `new Worker(import.meta.url)`, the file spawning itself —
// works, but needs `--allow-read` on the file, which put a permission in every program's
// shebang that had nothing to do with what the program could do. A blob URL needs none,
// so the shebang is now exactly the capabilities the build granted, and a program granted
// nothing asks for nothing.
//
// Worker detection is still `WorkerGlobalScope` rather than `import.meta.main`, which is
// true in both — the worker bundle has its own entry now, but the check guards the
// message handler below and getting it wrong would fail silently.

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
  Stat: { of(...a: unknown[]): unknown };
  Socket: { of(...a: unknown[]): unknown };
  /** The monomorphised `Pending<T>`s — one per capability return type. */
  Pending$i32: { of(...a: unknown[]): unknown };
  Pending$i64: { of(...a: unknown[]): unknown };
  Pending$string: { of(...a: unknown[]): unknown };
  Pending$stringOpt: { of(...a: unknown[]): unknown };
  Pending$u8Arr: { of(...a: unknown[]): unknown };
  Pending$bool: { of(...a: unknown[]): unknown };
  Pending$stringArrOpt: { of(...a: unknown[]): unknown };
  Pending$FileResult: { of(...a: unknown[]): unknown };
  Pending$Stat: { of(...a: unknown[]): unknown };
  Pending$Socket: { of(...a: unknown[]): unknown };
  Pending$Child: { of(...a: unknown[]): unknown };
  Child: { of(...a: unknown[]): unknown };
  Captured: { of(...a: unknown[]): unknown };
  Pending$Captured: { of(...a: unknown[]): unknown };
  Read: { Data(...a: unknown[]): unknown; End(): unknown; Failed(...a: unknown[]): unknown };
  Change: { of(...a: unknown[]): unknown };
  Pending$Change: { of(...a: unknown[]): unknown };
  Pending$Read: { of(...a: unknown[]): unknown };
  main: (core: unknown, cli: unknown) => number;

  // Only an interactive browser application has these, and bindgen emits a class only for a
  // struct the module actually mentions — so a `wc` that never names `Page` has no `Page`
  // here, and the browser launcher checks for `page` before offering one.
  Page?: { of(...a: unknown[]): unknown };
  Event?: { of(...a: unknown[]): unknown };
  Picked?: { of(...a: unknown[]): unknown };
  Pending$Event?: { of(...a: unknown[]): unknown };
  Pending$Picked?: { of(...a: unknown[]): unknown };
  /** The interactive entry point: draw, subscribe, and loop on `nextEvent`. */
  page?: (core: unknown, cli: unknown, page: unknown) => number;
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
export type Grants = { read?: boolean; write?: boolean; env?: boolean; net?: boolean };

/**
 * The worker half: wait for the bridge, build the capabilities, run `main`.
 *
 * Called by the generated worker entry, which imports this module *before* the
 * application so the handler above is installed first.
 */
export async function runAsWorkerEntry(app: AppModule): Promise<void> {
  await runAsWorker(app);
}

/**
 * The launcher half: serve the granted capabilities, spawn the worker, exit with its code.
 *
 * `workerSource` is the worker bundle, carried as a string and spawned from a blob URL so
 * the program needs no filesystem permission of its own. Every argument goes to the
 * application; the launcher takes none.
 */
export async function runLauncher(workerSource: string, grants: Grants = {}): Promise<void> {
  await runAsLauncher(workerSource, grants);
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

async function runAsLauncher(workerSource: string, grants: Grants): Promise<void> {
  const bridge = newBridge();
  const responder = serveHostCalls(bridge, denoWorld({
    args: [...Deno.args],
    fs: { read: grants.read === true, write: grants.write === true },
    net: grants.net === true,
    env: grants.env === true ? (n) => Deno.env.get(n) : undefined,
  }));

  const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
  const worker = new Worker(url, { type: "module" });
  const finished = new Promise<number>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as Result;
      if (m.ok) resolve(m.code);
      else reject(new Error(m.error));
    };
    worker.onerror = (e) => reject(new Error(e.message));
  });
  worker.postMessage({ sab: bridge.sab });

  // The code leaves the block rather than being exited with inside it, because `Deno.exit` does
  // not run `finally` — so this cleanup used to read as though it happened and never did. Here the
  // process was ending anyway and the operating system took care of it; the same spelling in
  // `app.ts` leaked a built executable per run until /tmp had 1.4GB of them.
  let code = 70;
  try {
    code = await finished;
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    responder.stop();
    worker.terminate();
    URL.revokeObjectURL(url);
  }
  Deno.exit(code);
}
