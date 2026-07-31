// Throughput benchmark for the gzip package.
//
// Reports MB/s for each block type and for inflate, against python's zlib as a
// reference. A throughput number with no baseline says nothing — the interesting
// question is not "how fast" but "how far off a real implementation, and why".
//
// The boundary is measured separately and reported first, because bindgen copies
// an array with one exported wasm call per element in each direction. For a 1 MB
// input that is ~2 million cross-boundary calls, and if that dominates then every
// codec number below is really measuring the copy.
//
//   deno run -A tools/bench.ts            # default sizes
//   deno run -A tools/bench.ts --scaling  # size sweep, to check for superlinearity

import { wacBind } from "../harness/wacBind.ts";

const scaling = Deno.args.includes("--scaling");

// ── Inputs ────────────────────────────────────────────────────────────────────

function prng(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7FFFFFFF;
    out[i] = (s >>> 16) & 0xFF;
  }
  return out;
}

function textLike(n: number): Uint8Array {
  const words = ["the", "quick", "brown", "fox", "deflate", "huffman", "window",
    "literal", "distance", "compression", "stream", "block"];
  const parts: string[] = [];
  let len = 0;
  let s = 7;
  while (len < n) {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7FFFFFFF;
    const w = words[(s >>> 8) % words.length];
    parts.push(w);
    len += w.length + 1;
  }
  return new TextEncoder().encode(parts.join(" ")).slice(0, n);
}

function inputs(n: number): [string, Uint8Array][] {
  return [
    ["text", textLike(n)],
    ["binary-ish", Uint8Array.from({ length: n }, (_, i) => (i % 251) & 0xFF)],
    ["incompressible", prng(n, 99)],
    ["all zeros", new Uint8Array(n)],
  ];
}

// ── Timing ────────────────────────────────────────────────────────────────────

/** Best-of-N wall time in ms. Best, not mean: it is the run least perturbed. */
function timeBest(fn: () => void, iterations: number): number {
  fn();                       // warm up: let the wasm JIT settle
  let best = Infinity;
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    const dt = performance.now() - t0;
    if (dt < best) best = dt;
  }
  return best;
}

const mbps = (bytes: number, ms: number) => (bytes / 1e6) / (ms / 1000);

// ── Load ──────────────────────────────────────────────────────────────────────

const gz = await wacBind("packages/gzip/src/gzip.wac");
const inf = await wacBind("packages/gzip/src/inflate.wac");
const id = await wacBind("tools/bench/identity.wac");

const identity = id.identity as (d: Uint8Array) => Uint8Array;
const checksum = id.checksum as (d: Uint8Array) => number;
const stored = gz.gzipStored as (d: Uint8Array) => Uint8Array;
const fixed = gz.gzipFixed as (d: Uint8Array) => Uint8Array;
const dynamic = gz.gzipDynamic as (d: Uint8Array) => Uint8Array;
const gunzipBytes = inf.gunzipBytes as (d: Uint8Array) => Uint8Array;

// ── Reference: python zlib, timed inside the python process ───────────────────

async function pythonThroughput(data: Uint8Array): Promise<{ comp: number; decomp: number }> {
  const src = `
import sys, time, zlib
data = sys.stdin.buffer.read()
best = min(
    (lambda t0: (zlib.compress(data, 6), time.perf_counter() - t0)[1])(time.perf_counter())
    for _ in range(3))
gzdata = zlib.compress(data, 6)
bestd = min(
    (lambda t0: (zlib.decompress(gzdata), time.perf_counter() - t0)[1])(time.perf_counter())
    for _ in range(3))
print(best * 1000, bestd * 1000)
`;
  const cmd = new Deno.Command("python3", {
    args: ["-c", src], stdin: "piped", stdout: "piped", stderr: "piped",
  });
  const child = cmd.spawn();
  const w = child.stdin.getWriter();
  await w.write(data);
  await w.close();
  const { stdout } = await child.output();
  const [c, d] = new TextDecoder().decode(stdout).trim().split(/\s+/).map(Number);
  return { comp: c, decomp: d };
}

// ── Boundary cost ─────────────────────────────────────────────────────────────

const N = 1 << 20;   // 1 MiB
const probe = prng(N, 1);

console.log(`host/wasm boundary, ${(N / 1e6).toFixed(2)} MB\n`);
const idMs = timeBest(() => { identity(probe); }, 5);
const sumMs = timeBest(() => { checksum(probe); }, 5);
console.log(`| operation | ms | MB/s |`);
console.log(`|---|---:|---:|`);
console.log(`| copy in + copy out (identity) | ${idMs.toFixed(1)} | ${mbps(N, idMs).toFixed(1)} |`);
console.log(`| copy in only (checksum) | ${sumMs.toFixed(1)} | ${mbps(N, sumMs).toFixed(1)} |`);
console.log(`\nEvery codec figure below includes a copy in, and the compressors a`);
console.log(`copy out too, so subtract roughly this much to see the codec itself.\n`);

// ── Codecs ────────────────────────────────────────────────────────────────────

if (!scaling) {
  for (const [shape, data] of inputs(N)) {
    console.log(`\n## ${shape}, ${(data.length / 1e6).toFixed(2)} MB\n`);
    console.log(`| codec | ms | MB/s | output |`);
    console.log(`|---|---:|---:|---:|`);

    for (const [name, fn] of [["stored", stored], ["fixed", fixed], ["dynamic", dynamic]] as const) {
      const ms = timeBest(() => { fn(data); }, 3);
      const out = fn(data).length;
      console.log(`| ${name} | ${ms.toFixed(0)} | ${mbps(data.length, ms).toFixed(1)} | ${(100 * out / data.length).toFixed(1)}% |`);
    }

    const gzipped = dynamic(data);
    const infMs = timeBest(() => { gunzipBytes(gzipped); }, 3);
    console.log(`| inflate | ${infMs.toFixed(0)} | ${mbps(data.length, infMs).toFixed(1)} | — |`);

    const py = await pythonThroughput(data);
    console.log(`| _python zlib compress_ | ${py.comp.toFixed(0)} | ${mbps(data.length, py.comp).toFixed(1)} | — |`);
    console.log(`| _python zlib decompress_ | ${py.decomp.toFixed(0)} | ${mbps(data.length, py.decomp).toFixed(1)} | — |`);
  }
}

// ── Scaling ───────────────────────────────────────────────────────────────────

if (scaling) {
  console.log(`\n## scaling — MB/s by input size\n`);
  console.log(`Flat means linear. Falling means something is superlinear, which for`);
  console.log(`LZ77 would point at the match search or the hash insert loop.\n`);
  const sizes = [1 << 14, 1 << 16, 1 << 18, 1 << 20, 1 << 22];
  console.log(`| shape | codec | ${sizes.map(s => `${(s / 1024) | 0}K`).join(" | ")} |`);
  console.log(`|---|---|${sizes.map(() => "---:").join("|")}|`);
  for (const shape of ["text", "incompressible", "all zeros"]) {
    for (const [name, fn] of [["dynamic", dynamic], ["inflate", null]] as const) {
      const row: string[] = [];
      for (const size of sizes) {
        const data = inputs(size).find(([s]) => s === shape)![1];
        if (name === "inflate") {
          const g = dynamic(data);
          const ms = timeBest(() => { gunzipBytes(g); }, 3);
          row.push(mbps(size, ms).toFixed(1));
        } else {
          const ms = timeBest(() => { fn!(data); }, 3);
          row.push(mbps(size, ms).toFixed(1));
        }
      }
      console.log(`| ${shape} | ${name} | ${row.join(" | ")} |`);
    }
  }
}
