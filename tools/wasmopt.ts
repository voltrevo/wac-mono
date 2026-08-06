// What does `wasm-opt` do to wac's output?
//
//     deno run -A --node-modules-dir=auto tools/wasmopt.ts
//
// **An experiment, not a build step.** Nothing in this repo depends on binaryen and nothing should start
// without a decision: wac's whole claim is a compiler in ~6,000 lines of TypeScript with no LLVM, no
// binaryen and no wasm toolchain, and that is about *building*. Whether a shipped artifact is worth
// post-processing is a separate question, which this file exists to answer with numbers rather than
// opinion. `npm:binaryen` is a portable JS/wasm build, not a native binary, so running it costs nothing
// but a dev-time dependency of this file — the same footing as `npm:ethers` in the vendor tools.
//
// The probe is `packages/crypto/test/wac/rawcalls.wac`: `i32 -> i32` exports, because the optimized module
// cannot be reached through bindgen (bindgen's glue is generated against the module the compiler emitted,
// and binaryen rewrites it).
//
// Read the numbers with the machine in mind — it is shared, and `/proc/loadavg` decides how much of a
// small difference is real. Best-of-nine is what makes the size figure and the direction trustworthy; a
// 5% speed claim from here is not.

import binaryen from "npm:binaryen@123.0.0";
import { wacCompile } from "wac/wacCompile.ts";
import { wacFiles } from "../harness/wacFiles.ts";

const ENTRY = "packages/crypto/test/wac/rawcalls.wac";
const MB = 1024 * 1024;
const SIZE = 4 * MB;

const files = await wacFiles(ENTRY);
const result = wacCompile(files, ENTRY, {}) as unknown as Record<string, unknown>;
if (!result.ok) {
  console.error(result.diagnostics);
  throw new Error(`${ENTRY} did not compile`);
}
const emitted = (result.compiled as Record<string, unknown>).wasm as Uint8Array;

binaryen.setOptimizeLevel(3);
binaryen.setShrinkLevel(0);
const module = binaryen.readBinary(emitted);
module.setFeatures(binaryen.Features.All);
if (module.validate() !== 1) throw new Error("binaryen rejected the emitted module");
module.optimize();
const optimized = module.emitBinary();

console.log(`emitted   ${emitted.length} bytes`);
console.log(`wasm-opt  ${optimized.length} bytes  (${((1 - optimized.length / emitted.length) * 100).toFixed(0)}% smaller)`);
console.log();

const best = (f: () => void, runs = 9) => {
  let ms = Infinity;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    f();
    ms = Math.min(ms, performance.now() - t);
  }
  return ms;
};

const times: Record<string, number[]> = {};
for (const [label, bytes] of [["emitted", emitted], ["wasm-opt", optimized]] as [string, Uint8Array][]) {
  // Compiled and instantiated in two steps rather than through `WebAssembly.instantiate`, whose overloads
  // resolve to the `Module` form for one of these two arrays and the `Source` form for the other. The copy
  // is for the types, not the runtime: `Uint8Array<ArrayBufferLike>` — what binaryen hands back — is not a
  // `BufferSource`, because a `SharedArrayBuffer` cannot be one.
  const view = new Uint8Array(bytes.length);
  view.set(bytes);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(view), {});
  const e = instance.exports as unknown as Record<string, (n: number) => number>;
  e.optBuild(1024);
  // The input is built inside the module — see `rawcalls.wac` — so its cost is measured and subtracted,
  // exactly as `packages/crypto/bench/hash.ts` does. Without this every figure is 2-3x too slow.
  const build = best(() => e.optBuild(SIZE));
  for (const name of ["optChacha", "optSha256", "optKeccak"]) {
    const ms = Math.max(0.001, best(() => e[name](SIZE)) - build);
    (times[name] ??= []).push(ms);
    console.log(`${label.padEnd(9)} ${name.slice(3).padEnd(8)} ${ms.toFixed(1).padStart(7)} ms  ` +
      `${(4 / (ms / 1000)).toFixed(0).padStart(4)} MB/s`);
  }
}

console.log();
for (const [name, [before, after]] of Object.entries(times)) {
  console.log(`${name.slice(3).padEnd(8)} ${((before / after - 1) * 100).toFixed(0).padStart(4)}% faster`);
}
console.log(`\nload now: ${(await Deno.readTextFile("/proc/loadavg")).trim()}`);
