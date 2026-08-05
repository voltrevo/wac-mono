import { spawnChild } from "../packages/platform/host/children.ts";
import { serveHostCalls } from "../packages/platform/host/respond.ts";
import { denoWorld } from "../packages/platform/host/deno.ts";
import { bridgeOf, newBridge } from "../packages/platform/host/layout.ts";
import { buildApp } from "../packages/platform/build.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const BOX = "packages/box/src/box.wac";

// Two artifacts of the same program: an executable, and the worker half on its own.
const exe = await Deno.makeTempFile({ prefix: "cmp-exe-" });
const wrk = await Deno.makeTempFile({ prefix: "cmp-wrk-" });
await buildApp(BOX, exe, { read: true });
await buildApp(BOX, wrk, { read: true }, "deno", true);
const source = await Deno.readTextFile(wrk);

const fixture = await Deno.makeTempFile({ prefix: "cmp-in-" });
await Deno.writeTextFile(fixture, "alpha beta\ngamma\ndelta epsilon zeta\n");

function viaProcess(args: string[]): { code: number; out: string } {
  const r = new Deno.Command(exe, { args, stdout: "piped", stderr: "null" }).outputSync();
  return { code: r.code, out: dec.decode(r.stdout) };
}

async function viaWorker(args: string[]): Promise<{ code: number; out: string }> {
  const child = spawnChild(
    source,
    args.map((a) => enc.encode(a)),
    (sab, cargs, out, input, cerr) =>
      serveHostCalls(bridgeOf(sab), denoWorld({
        args: cargs,
        fs: { read: true, write: false },
        log: async (l: string) => { await out.push(enc.encode(l + "\n")); },
        warn: async (l: string) => { await cerr.push(enc.encode(l + "\n")); },
        write: async (b: Uint8Array) => { if (!await out.push(b)) throw new Error("not read"); },
        writeErr: async (b: Uint8Array) => { await cerr.push(b); },
        readStdin: () => input.rest(),
        readStdinChunk: () => input.next(),
      })),
    () => newBridge(),
  );
  const why = await child.loaded;
  if (why !== "") throw new Error(`worker did not load: ${why}`);
  child.in.end();
  const code = await child.exit;
  return { code, out: dec.decode(await child.out.rest()) };
}

// Correctness before speed: the two paths must agree.
const args = ["cat", fixture];
const p = viaProcess(args);
const w = await viaWorker(args);
console.log(`  agree: ${p.out === w.out && p.code === w.code}  (process exit ${p.code}, worker exit ${w.code})`);
if (p.out !== w.out) console.log(`    process: ${JSON.stringify(p.out.slice(0,40))}\n    worker:  ${JSON.stringify(w.out.slice(0,40))}`);

const N = 10;
let t0 = performance.now();
for (let i = 0; i < N; i++) viaProcess(args);

console.log(`  process spawn: ${((performance.now() - t0) / N).toFixed(0)}ms each`);
t0 = performance.now();
for (let i = 0; i < N; i++) await viaWorker(args);
console.log(`  worker  spawn: ${((performance.now() - t0) / N).toFixed(0)}ms each`);

await Deno.remove(exe); await Deno.remove(wrk); await Deno.remove(fixture);
