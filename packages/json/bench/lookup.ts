// Where a hash index starts beating a linear scan for JSON object lookup.
//
// This exists to set one number: `JsonObject.INDEX_MIN`. Below it `get` scans, above it `get`
// builds an index. Picking that by taste would be guessing — a scan over contiguous members
// that compares length first is very fast at the sizes real documents contain, and hashing a
// key is not free.
//
//   deno task bench:json-lookup

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/json/bench/lookup.wac") as unknown as {
  scanKeys(n: number, reps: number): number;
  indexedKeys(n: number, reps: number): number;
  buildOnly(n: number, reps: number): number;
};

const REPS = 200_000;
const SIZES = [2, 4, 8, 12, 16, 24, 32, 64, 128, 256, 1024];

/** Best of three, because the fastest run is the one least disturbed by the rest of the box. */
function time(f: () => void): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    f();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

// Warm up, so the first measured size does not pay for JIT compilation of the export wrapper.
mod.scanKeys(8, 10_000);
mod.indexedKeys(8, 10_000);

console.log(`${REPS.toLocaleString()} lookups, cycling through every key. ns.\n`);
console.log("| members | scan/lookup | indexed/lookup | index build | break-even lookups |");
console.log("|---:|---:|---:|---:|---|");

const BUILD_REPS = 20_000;
for (const n of SIZES) {
  const scan = time(() => mod.scanKeys(n, REPS)) * 1e6 / REPS;
  const indexed = time(() => mod.indexedKeys(n, REPS)) * 1e6 / REPS;
  const build = time(() => mod.buildOnly(n, BUILD_REPS)) * 1e6 / BUILD_REPS;
  // How many lookups it takes for the index to repay its own construction.
  const saved = scan - indexed;
  const breakEven = saved > 0 ? Math.ceil(build / saved) : Infinity;
  const verdict = Number.isFinite(breakEven) ? `${breakEven}` : "never";
  console.log(
    `| ${n} | ${scan.toFixed(0)} | ${indexed.toFixed(0)} | ${build.toFixed(0)} | ${verdict} |`,
  );
}
