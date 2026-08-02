// Run a wac application. The main thread compiles it, answers its host calls, and waits.
//
// The application has no TypeScript of its own — that is the point of the world. This
// file is the whole host, for every application, and an application is a `.wac` entry
// that exports an `App` struct.

import { wacCompile } from "wac/wacCompile.ts";
import { wacBindgen } from "wac/wacBindgen.ts";
import { wacFiles } from "../../../harness/wacFiles.ts";
import { checkWacVersion } from "../../../harness/wacVersion.ts";
import { newBridge } from "./layout.ts";
import { type Handlers, serveHostCalls } from "./respond.ts";
import { denoWorld, type DenoWorldOptions } from "./deno.ts";

const CACHE_DIR = ".cache";

export type RunOptions = DenoWorldOptions & {
  /** Override the capability table entirely, for tests. */
  handlers?: Handlers;
};

/**
 * Compile and run `entry`, returning its exit code.
 *
 * The application runs on a worker because a worker may block; this thread stays free to
 * answer its host calls, which is what lets an asynchronous capability look synchronous
 * from wac. A main thread that blocked here would deadlock against the worker waiting
 * on it.
 */
export async function runApp(entry: string, opts: RunOptions = {}): Promise<number> {
  checkWacVersion();

  const r = wacCompile(await wacFiles(entry), entry);
  if (!r.ok) {
    throw new Error(
      `${entry} did not compile:\n` +
        r.diagnostics.map((d) => `  ${d.file}:${d.line}:${d.col} ${d.message}`).join("\n"),
    );
  }
  await Deno.mkdir(CACHE_DIR, { recursive: true });
  const out = `${CACHE_DIR}/${entry.replaceAll("/", "_")}.app.ts`;
  const tmp = `${out}.${crypto.randomUUID()}.tmp`;
  await Deno.writeTextFile(tmp, wacBindgen(r.compiled));
  await Deno.rename(tmp, out);

  const bridge = newBridge();
  const responder = serveHostCalls(bridge, opts.handlers ?? denoWorld(opts));

  // No `deno.permissions` — that is an unstable option, and the worker needs nothing
  // beyond importing the generated module. Every capability it has comes through the
  // bridge, answered on this thread, which is the design working rather than a
  // restriction to work around.
  const worker = new Worker(import.meta.resolve("./worker.ts"), { type: "module" });
  const finished = new Promise<number>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { ok: true; code: number } | { ok: false; error: string };
      if (m.ok) resolve(m.code);
      else reject(new Error(m.error));
    };
    worker.onerror = (e) => reject(new Error(e.message));
  });
  worker.postMessage({ sab: bridge.sab, modulePath: `${Deno.cwd()}/${out}` });

  try {
    return await finished;
  } finally {
    responder.stop();
    worker.terminate();
  }
}
