// How fast, rather than how small.
//
//   deno task bench:zstd-speed
//
// Both sides time themselves — ours inside Deno, zstd's inside Node — so neither figure includes
// the cost of getting the data to the other process. What each *does* include is its own
// boundary: ours copies the input across the wasm boundary and the output back, which is real
// and which a caller pays, so it stays in.
//
// This is not a like-for-like comparison and cannot be. zstd is native code that has been tuned
// for twenty years; this is wasm compiled from a language with no unsafe escape hatch. The
// number worth knowing is the order of magnitude, and whether it is the same order.

import { wacBind } from "../../../harness/wacBind.ts";
import { corpus } from "./corpus.ts";

const enc = await wacBind("packages/zstd/src/encode.wac") as unknown as {
  compress(d: Uint8Array): Uint8Array;
};
const dec = await wacBind("packages/zstd/src/frame.wac") as unknown as {
  decompress(d: Uint8Array): Uint8Array;
};

/** Best of `rounds`, because the interesting figure is what it can do, not what it averaged. */
function best(f: () => void, rounds: number): number {
  f();
  let ms = Infinity;
  for (let i = 0; i < rounds; i++) {
    const t = performance.now();
    f();
    const took = performance.now() - t;
    if (took < ms) ms = took;
  }
  return ms;
}

function b64(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192));
  return btoa(s);
}

type Timing = { comp: number; decomp: number; gzipComp: number; gzipDecomp: number; frame: string };

/** zstd and gzip, timed inside Node so the handover is not counted against them. */
async function hostTimings(samples: Uint8Array[], rounds: number): Promise<Timing[]> {
  const script = `
    const z = require("zlib");
    const c = [];
    process.stdin.on("data", d => c.push(d)).on("end", () => {
      const { jobs, rounds } = JSON.parse(Buffer.concat(c).toString());
      const best = f => { f(); let ms = Infinity;
        for (let i = 0; i < rounds; i++) { const t = process.hrtime.bigint(); f();
          const took = Number(process.hrtime.bigint() - t) / 1e6; if (took < ms) ms = took; }
        return ms; };
      process.stdout.write(JSON.stringify(jobs.map(j => {
        const b = Buffer.from(j, "base64");
        const z3 = z.zstdCompressSync(b);
        const gz = z.gzipSync(b, { level: 6 });
        return {
          comp: best(() => z.zstdCompressSync(b)),
          decomp: best(() => z.zstdDecompressSync(z3)),
          gzipComp: best(() => z.gzipSync(b, { level: 6 })),
          gzipDecomp: best(() => z.gunzipSync(gz)),
          // The very bytes zstd timed itself decoding, so ours can be timed on the same work.
          frame: z3.toString("base64"),
        };
      })));
    });`;
  const cmd = new Deno.Command("node", { args: ["-e", script], stdin: "piped", stdout: "piped", stderr: "piped" });
  const child = cmd.spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(JSON.stringify({ jobs: samples.map(b64), rounds })));
  await w.close();
  const { code, stdout, stderr } = await child.output();
  if (code !== 0) throw new Error(`node failed: ${new TextDecoder().decode(stderr)}`);
  return JSON.parse(new TextDecoder().decode(stdout));
}

const ROUNDS = 5;
const samples = (await corpus()).filter(s => s.data.length > 100_000);
const host = await hostTimings(samples.map(s => s.data), ROUNDS);

const rate = (bytes: number, ms: number) => bytes / 1e6 / (ms / 1000);

console.log("## Compression, MB/s\n");
console.log("| sample | ours | zstd -3 | gzip -6 | ours vs zstd |");
console.log("|---|---:|---:|---:|---:|");
for (let i = 0; i < samples.length; i++) {
  const s = samples[i];
  const ms = best(() => { enc.compress(s.data); }, ROUNDS);
  const ours = rate(s.data.length, ms);
  const theirs = rate(s.data.length, host[i].comp);
  console.log(`| ${s.name} | ${ours.toFixed(1)} | ${theirs.toFixed(1)} | ${rate(s.data.length, host[i].gzipComp).toFixed(1)} | ${(theirs / ours).toFixed(1)}x slower |`);
}

console.log("\n## Decompression, MB/s\n");
console.log("Both decoders on the *same* frame — zstd's own output. Decoding our frames instead");
console.log("would have us verifying a checksum that zstd's default frames do not carry, which is");
console.log("about a sixth of our decode time and none of theirs.\n");
console.log("| sample | ours | zstd | gzip | ours vs zstd |");
console.log("|---|---:|---:|---:|---:|");
const unb64 = (str: string) => Uint8Array.from(atob(str), c => c.charCodeAt(0));
for (let i = 0; i < samples.length; i++) {
  const s = samples[i];
  const frame = unb64(host[i].frame);
  const ms = best(() => { dec.decompress(frame); }, ROUNDS);
  const ours = rate(s.data.length, ms);
  const theirs = rate(s.data.length, host[i].decomp);
  console.log(`| ${s.name} | ${ours.toFixed(1)} | ${theirs.toFixed(1)} | ${rate(s.data.length, host[i].gzipDecomp).toFixed(1)} | ${(theirs / ours).toFixed(1)}x slower |`);
}
