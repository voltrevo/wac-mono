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
//   const r = await box.run(["cat", path]);                    // r.code, r.out, r.err
//   const s = await sh.run(["-c", script], { env: { LC_ALL: "C" }, stdin: "..." });
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
import { type Bridge, bridgeOf, newBridge } from "../packages/platform/host/layout.ts";
import { describeSlots } from "../packages/platform/host/call.ts";
import { buildApp, type Grants } from "../packages/platform/build.ts";

export type RunResult = {
  /** The program's exit code, or negative if it never ran. */
  code: number;
  out: string;
  err: string;
  /** Standard output as bytes, for a program whose output is not text. */
  bytes: Uint8Array;
};

export type RunOptions = {
  /**
   * Called with the phase this run is in, for a caller that narrates a wedge.
   *
   * wac-mono 0082: four corpus cases hung for ten minutes, and the narration could say which *half* of
   * each case was stuck — `[wacsh]`, ours rather than bash — but not which await inside it. There are
   * three candidates and they are different bugs: the child never reports ready, the child never exits,
   * or its output queues are never ended so the drain does not finish.
   */
  note?: (what: string) => void;
  /** What the program reads as its standard input. Absent means it reads nothing. */
  stdin?: string | Uint8Array;
  /**
   * The environment the program sees.
   *
   * Given, it sees exactly these and nothing else — `Deno.Command`'s `clearEnv`, which is what a
   * differential test needs: `LC_ALL=C` and a known `PATH` and no inheritance, so the comparison
   * is against a fixed world rather than against whatever the suite was started with. Omitted, the
   * `env` grant decides: granted, the process's own; not granted, every variable unset.
   */
  env?: Record<string, string>;
  /** Where the program's relative paths resolve from, and what `cwd` reports. */
  cwd?: string;
};

export type AppRunner = {
  run(args: string[], opts?: RunOptions): Promise<RunResult>;
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
    async run(args, opts = {}) {
      // Kept so a stall can be described: the slot table says whether the child is blocked in a host
      // call and which one. Without it a wedged run reports "still running" and nothing else, which is
      // where wac-mono 0082 stood for two days.
      let bridge: Bridge | undefined;
      // And the responder, because "the worker is waiting" and "the host stopped answering" are the two
      // halves of a stall and the slot table alone cannot tell them apart: a sweep count that stops
      // moving says the loop is parked, and `running: false` says it is gone.
      let responder: { stats(): { running: boolean; sweeps: number } } | undefined;
      const child = spawnChild(
        source,
        args.map((a) => enc.encode(a)),
        (sab, cargs, out, input, cerr) =>
          (responder = serveHostCalls(bridgeOf(sab), denoWorld({
            args: cargs,
            // Absent rather than false where nothing is granted: the world reads a missing option
            // as "no such capability", and `fs: {}` is not the same as no `fs`. Copied from
            // `deno.ts`'s spawn path, which is the reference for what a child is handed.
            ...(grants.read === true || grants.write === true
              ? { fs: { read: grants.read === true, write: grants.write === true } }
              : {}),
            ...(grants.net === true ? { net: true } : {}),
            // A supplied environment wins over the grant, and is exhaustive: a name not in it is
            // unset, not inherited.
            ...(opts.env !== undefined
              ? { env: (n: string) => opts.env![n] }
              : grants.env === true
              ? { env: (n: string) => Deno.env.get(n) }
              : {}),
            ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
            log: async (l: string) => { await out.push(enc.encode(l + "\n")); },
            warn: async (l: string) => { await cerr.push(enc.encode(l + "\n")); },
            write: async (b: Uint8Array) => {
              if (!await out.push(b)) throw new Error("the program's output is not being read");
            },
            writeErr: async (b: Uint8Array) => { await cerr.push(b); },
            readStdin: () => input.rest(),
            readStdinChunk: () => input.next(),
            selfSource: source,
          }))),
        () => {
          bridge = newBridge();
          return bridge;
        },
      );

      const note = opts.note ?? (() => {});
      note("loading");
      const why = await child.loaded;
      if (why !== "") throw new Error(`${entry} did not load: ${why}`);

      // **Drain before waiting, not after.** The output queues are capped at 8 MB, so reading only
      // after `exit` breaks any program that writes more than that. Measured, with the drain moved
      // back after the exit: `box seq 1 2000000` (~13 MB) fails with `the program's output is not
      // being read`, thrown from the `write` handler below — and thrown *out of the test*, so Deno
      // reports "this error was not caught from a test and caused the test runner to fail on the
      // referenced module" and takes the whole file with it rather than one case.
      //
      // `rest()` releases room as it takes chunks, so starting it first drains continuously and the
      // size stops mattering. `shutdown()` ends both queues, which is what lets these resolve.
      note("running");
      // A child that never finishes says what it is waiting on, every 45 seconds, to standard error.
      // It cannot fail anything — it prints — so the budget can be short enough to be useful without
      // being tuned against a loaded machine. Cleared in the `finally` below.
      // `WAC_STALL_MS` so this can be provoked in a second rather than only by a real wedge — a
      // narrator that is never seen to fire is one nobody knows is broken.
      const stallMs = Number(Deno.env.get("WAC_STALL_MS") ?? "45000");
      const stall = setInterval(() => {
        if (bridge === undefined) return;
        try {
          const host = responder === undefined
            ? ""
            : ` host: running=${responder.stats().running} sweeps=${responder.stats().sweeps}`;
          console.error(`wac: ${entry} still running: ${describeSlots(bridge)}${host}`);
        } catch {
          // A bridge whose buffer has gone is not worth an exception here.
        }
      }, Number.isFinite(stallMs) && stallMs > 0 ? stallMs : 45_000);
      Deno.unrefTimer(stall);
      const draining = Promise.all([child.out.rest(), child.err.rest()]);

      // Standard input is whatever the caller gave, then end — a program that reads to the end has
      // to see one. Pushed before awaiting the exit, since a filter blocks until it has input.
      if (opts.stdin !== undefined) {
        await child.in.push(typeof opts.stdin === "string" ? enc.encode(opts.stdin) : opts.stdin);
      }
      child.in.end();

      try {
        const code = await child.exit;
        note("draining");
        const [bytes, errBytes] = await draining;
        note("done");
        return { code, out: dec.decode(bytes), err: dec.decode(errBytes), bytes };
      } finally {
        clearInterval(stall);
      }
    },
  };
}
