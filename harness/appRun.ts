// Run a wac application in this process, instead of spawning it.
//
// A built program is a launcher plus a worker: the launcher serves the granted capabilities over a
// `SharedArrayBuffer` bridge and the worker holds the wasm. A test that wants to run one has been
// building the executable and spawning it, which pays for a whole second Deno process — and tests
// that do it per case are what `packages/box` and `packages/sh` mostly cost.
//
// Nothing about that is necessary. `spawnChild` already takes the worker source and an injectable
// worker factory, precisely so a caller can be the launcher; `packages/platform/host/deno.ts` does
// exactly this when a wac program spawns another. So a test can be the launcher too, and the
// "spawn" becomes a `Worker` in the same process.
//
// Measured on `packages/box`, `cat` over a small file: **112ms as a subprocess, 64ms as a worker**,
// with byte-identical output and the same exit code.
//
//   const box = await appRunner("packages/box/src/box.wac", { read: true });
//   const r = await box.run(["cat", path]);        // r.code, r.out, r.err
//
// ## What this is not
//
// It is not isolation. The worker shares this process, and the world it is handed is built here —
// which is the same authority a spawned child gets from its parent, and the same reason
// `children.ts` says the isolation is the language's rather than the runtime's. A test that is
// *about* process boundaries — `spawn`, exit codes across a real fork, `Text file busy` — still
// wants the executable, and `buildApp` is still there for it.
//
// It also does not make a second run cheap. The app contract is `main(Core, Cli) -> i32` run once:
// `entry.ts`'s worker waits for one start message, runs, and returns. So each `run` is a fresh
// worker, which is why this is 1.75× and not 10× — the bundle is parsed and the wasm compiled every
// time. Making the worker serve repeated runs is the "service" its own comment anticipates, and is
// wac-mono issue 0076.

import { spawnChild } from "../packages/platform/host/children.ts";
import { serveHostCalls } from "../packages/platform/host/respond.ts";
import { denoWorld } from "../packages/platform/host/deno.ts";
import { bridgeOf, newBridge } from "../packages/platform/host/layout.ts";
import { buildApp, type Grants } from "../packages/platform/build.ts";

export type RunResult = {
  /** The program's exit code, or negative if it never ran. */
  code: number;
  out: string;
  err: string;
  /** Standard output as bytes, for a program whose output is not text. */
  bytes: Uint8Array;
};

export type AppRunner = {
  run(args: string[], stdin?: string | Uint8Array): Promise<RunResult>;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

/** The worker halves already built in this process, by entry and grants. */
const sources = new Map<string, Promise<string>>();

async function workerSource(entry: string, grants: Grants): Promise<string> {
  const key = JSON.stringify([entry, grants]);
  let pending = sources.get(key);
  if (pending === undefined) {
    pending = (async () => {
      const out = await Deno.makeTempFile({ prefix: "apprun-" });
      try {
        await buildApp(entry, out, grants, "deno", /*workerOnly*/ true);
        return await Deno.readTextFile(out);
      } finally {
        await Deno.remove(out).catch(() => {});
      }
    })();
    sources.set(key, pending);
  }
  return await pending;
}

/**
 * A runner for one program with one set of grants.
 *
 * The worker *source* is built once and kept; each `run` spawns a worker from it. Held per
 * (entry, grants) across every runner in the process, so twenty tests asking for the same program
 * build it once.
 */
export async function appRunner(entry: string, grants: Grants = {}): Promise<AppRunner> {
  const source = await workerSource(entry, grants);

  return {
    async run(args, stdin) {
      const child = spawnChild(
        source,
        args.map((a) => enc.encode(a)),
        (sab, cargs, out, input, cerr) =>
          serveHostCalls(bridgeOf(sab), denoWorld({
            args: cargs,
            // Absent rather than false where nothing is granted: the world reads a missing option
            // as "no such capability", and `fs: {}` is not the same as no `fs`. Copied from
            // `deno.ts`'s spawn path, which is the reference for what a child is handed.
            ...(grants.read === true || grants.write === true
              ? { fs: { read: grants.read === true, write: grants.write === true } }
              : {}),
            ...(grants.net === true ? { net: true } : {}),
            ...(grants.env === true ? { env: (n: string) => Deno.env.get(n) } : {}),
            log: async (l: string) => { await out.push(enc.encode(l + "\n")); },
            warn: async (l: string) => { await cerr.push(enc.encode(l + "\n")); },
            write: async (b: Uint8Array) => {
              if (!await out.push(b)) throw new Error("the program's output is not being read");
            },
            writeErr: async (b: Uint8Array) => { await cerr.push(b); },
            readStdin: () => input.rest(),
            readStdinChunk: () => input.next(),
            selfSource: source,
          })),
        () => newBridge(),
      );

      const why = await child.loaded;
      if (why !== "") throw new Error(`${entry} did not load: ${why}`);

      // Standard input is whatever the caller gave, then end — a program that reads to the end has
      // to see one. Pushed before awaiting the exit, since a filter blocks until it has input.
      if (stdin !== undefined) {
        await child.in.push(typeof stdin === "string" ? enc.encode(stdin) : stdin);
      }
      child.in.end();

      const code = await child.exit;
      const bytes = await child.out.rest();
      return { code, out: dec.decode(bytes), err: dec.decode(await child.err.rest()), bytes };
    },
  };
}
