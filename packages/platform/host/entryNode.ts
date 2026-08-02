// The two halves of a built program, for Node.
//
// Same bridge, same opcodes, same capability structs — only the thread API and the
// platform calls differ. Node's `worker_threads` is not the web `Worker`: the message
// port is `parentPort` rather than `self`, and a worker is spawned from source with
// `{ eval: true }` rather than from a URL, which suits a bundled program better than the
// blob URL Deno uses since there is no URL to make.
//
// Node 22 runs an extensionless file as ESM with top-level await, so a built program can
// be `./wc` here as it is under Deno. Checked before this was written.
//
// Node has no permission system, so the grants are enforced by the capability world alone
// — see `node.ts`.

import { bridgeOf, CHUNK, newBridge } from "./layout.ts";
import { serveHostCalls } from "./respond.ts";
import { nodeWorld } from "./node.ts";
import { cliOf, coreOf } from "./provider.ts";
import type { AppModule, Grants } from "./entry.ts";

/** Node's `worker_threads`, described rather than imported so this checks under Deno. */
type ParentPort = { postMessage(m: unknown): void; on(e: "message", f: (m: unknown) => void): void };
type NodeWorker = {
  postMessage(m: unknown): void;
  on(e: "message" | "error" | "exit", f: (m: never) => void): void;
  terminate(): Promise<number>;
};
type WorkerThreads = {
  parentPort: ParentPort | null;
  Worker: new (src: string, opts: { eval: boolean }) => NodeWorker;
};

type Start = { sab: SharedArrayBuffer };
type Result = { ok: true; code: number } | { ok: false; error: string };

/**
 * The worker half.
 *
 * The handler is attached before anything can await, for the reason the Deno half
 * documents: the application module suspends at its top-level `WebAssembly.instantiate`,
 * and a message arriving in that window would be lost.
 */
export function runAsWorkerEntryNode(wt: WorkerThreads, app: AppModule): void {
  const port = wt.parentPort;
  if (port === null) throw new Error("runAsWorkerEntryNode called off a worker");
  port.on("message", (m: unknown) => {
    const b = bridgeOf((m as Start).sab);
    try {
      if (typeof app.main !== "function") {
        throw new Error("an application must export `main(Core, Cli) -> i32`");
      }
      port.postMessage({ ok: true, code: app.main(coreOf(b, app), cliOf(b, app)) } as Result);
    } catch (err) {
      port.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) } as Result);
    }
  });
}

/** The launcher half: serve the granted capabilities, run the worker, exit with its code. */
export async function runLauncherNode(
  wt: WorkerThreads,
  fs: {
    readFile(p: string): Promise<Uint8Array>;
    writeFile(p: string, d: Uint8Array): Promise<void>;
    mkdir(p: string, o: { recursive: boolean }): Promise<unknown>;
    rm(p: string, o: { recursive: boolean; force: boolean }): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    open(p: string, flags: string): Promise<{
      read(b: Uint8Array, off: number, len: number): Promise<{ bytesRead: number }>;
      close(): Promise<void>;
    }>;
    stat(p: string): Promise<{ isFile(): boolean; isDirectory(): boolean; size: number; mtimeMs: number }>;
    readdir(p: string): Promise<string[]>;
  },
  proc: {
    argv: string[];
    env: Record<string, string | undefined>;
    exit(code: number): never;
    stdin: AsyncIterable<Uint8Array>;
    stdout: { write(b: Uint8Array, cb: (e?: unknown) => void): void };
  },
  workerSource: string,
  grants: Grants = {},
): Promise<void> {
  let stdinIter: AsyncIterator<Uint8Array> | null = null;
  const io = {
    readStdin: async (): Promise<Uint8Array> => {
      const parts: Uint8Array[] = [];
      for await (const c of proc.stdin) parts.push(c);
      const total = parts.reduce((a, p) => a + p.length, 0);
      const out = new Uint8Array(total);
      let at = 0;
      for (const p of parts) { out.set(p, at); at += p.length; }
      return out;
    },
    // Node hands standard input over as an async iterable, which is already the shape a
    // chunked read wants: one `next()` is one chunk, and `done` is the end.
    readStdinChunk: async (): Promise<Uint8Array> => {
      stdinIter ??= proc.stdin[Symbol.asyncIterator]();
      const r = await stdinIter.next();
      return r.done === true ? new Uint8Array(0) : r.value;
    },
    openFile: async (path: string) => {
      const h = await fs.open(path, "r");
      const b = new Uint8Array(CHUNK);
      return {
        read: async (): Promise<Uint8Array> => {
          const { bytesRead } = await h.read(b, 0, CHUNK);
          return bytesRead === 0 ? new Uint8Array(0) : b.subarray(0, bytesRead);
        },
        close: () => h.close(),
      };
    },
    writeStdout: (b: Uint8Array): Promise<void> =>
      new Promise((res, rej) => proc.stdout.write(b, (e) => (e ? rej(e) : res()))),
    stat: async (path: string) => {
      const st = await fs.stat(path);
      return {
        isFile: st.isFile(), isDirectory: st.isDirectory(),
        size: st.size, mtimeMillis: Math.round(st.mtimeMs),
      };
    },
    readDir: async (path: string) => (await fs.readdir(path)).sort(),
  };
  const bridge = newBridge();
  const responder = serveHostCalls(bridge, nodeWorld(fs, proc, io, {
    args: proc.argv.slice(2),
    fs: { read: grants.read === true, write: grants.write === true },
    env: grants.env === true ? (n) => proc.env[n] : undefined,
  }));

  const worker = new wt.Worker(workerSource, { eval: true });
  // Node queues messages on a port until a listener attaches, so unlike the web worker
  // this cannot be posted too early — but it does have to be posted at all.
  worker.postMessage({ sab: bridge.sab } satisfies Start);
  const code = await new Promise<number>((resolve, reject) => {
    worker.on("message", ((m: Result) => {
      if (m.ok) resolve(m.code);
      else reject(new Error(m.error));
    }) as (m: never) => void);
    worker.on("error", ((e: Error) => reject(e)) as (m: never) => void);
  }).catch((e: unknown) => {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 70;
  });

  responder.stop();
  await worker.terminate();
  proc.exit(code);
}
