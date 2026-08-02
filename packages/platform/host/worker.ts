// The worker: where the application runs, and the only thread allowed to block.
//
// It imports the application's generated module, builds the capability structs from the
// bridge, and calls the shape the application implements. Everything it does after that
// is the application's own code.
//
// `onmessage` is installed before the first `await`, because module evaluation suspends
// there and a message arriving in that window is lost. `packages/stream` found this by
// getting it wrong; it is repeated here rather than rediscovered.

import { bridgeOf } from "./layout.ts";
import { coreOf, cliOf } from "./provider.ts";

type Start = { sab: SharedArrayBuffer; modulePath: string };
type Result = { ok: true; code: number } | { ok: false; error: string };

const worker = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(m: Result): void;
};

let pending: Start | null = null;
let ready: ((s: Start) => void) | null = null;
worker.onmessage = (e: MessageEvent) => {
  const start = e.data as Start;
  if (ready !== null) ready(start);
  else pending = start;
};

const start: Start = pending ?? await new Promise<Start>((res) => { ready = res; });
const b = bridgeOf(start.sab);

try {
  const mod = await import(start.modulePath) as Record<string, unknown>;
  const cls = mod as unknown as {
    Core: { of(...a: unknown[]): unknown };
    Cli: { of(...a: unknown[]): unknown };
    FileResult: new (ref: unknown) => unknown;
    fileResult?: (ok: boolean, bytes: Uint8Array, error: string) => unknown;
    App: { start(...a: unknown[]): { run(): number } };
  };

  // The application's own constructor for a FileResult, exported from its wac. A struct
  // has no constructor JavaScript can reach, so building one is wac's job.
  const mk = {
    fileResult: (ok: boolean, bytes: Uint8Array, error: string) => {
      if (typeof cls.fileResult !== "function") {
        throw new Error("the application must export `fileResult` to use readFile");
      }
      return cls.fileResult(ok, bytes, error);
    },
  };

  const core = coreOf(b, cls);
  const app = cls.App.start(core, cliOf(b, cls, mk));
  worker.postMessage({ ok: true, code: app.run() });
} catch (e) {
  worker.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
}
