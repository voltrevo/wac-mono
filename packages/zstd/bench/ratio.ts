// How well the compressor does, on data that resembles what compressors are used on.
//
//   deno task bench:zstd
//
// Against gzip -6 and zstd at three levels, because the interesting questions are "is this worth
// using instead of gzip" and "how far is it from the thing it is imitating" — neither of which a
// ratio on its own answers.
//
// The per-sample breakdown matters more than the total. A compressor that wins on source and
// loses on binaries has a specific missing piece, and averaging that away is how you end up
// optimising the wrong thing — which happened here, twice, before the corpus was real.

import { wacBind } from "../../../harness/wacBind.ts";
import { corpus, describe, type Sample } from "./corpus.ts";

const mod = await wacBind("packages/zstd/src/encode.wac") as unknown as {
  compress(data: Uint8Array): Uint8Array;
};

function b64(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192));
  return btoa(s);
}

type Reference = { gzip: number; z1: number; z3: number; z19: number };

/** gzip and zstd from the host, in one subprocess. */
async function reference(samples: Sample[]): Promise<Reference[]> {
  const script = `
    const z = require("zlib");
    const c = [];
    process.stdin.on("data", d => c.push(d)).on("end", () => {
      const jobs = JSON.parse(Buffer.concat(c).toString());
      const at = l => ({ params: { [z.constants.ZSTD_c_compressionLevel]: l } });
      process.stdout.write(JSON.stringify(jobs.map(j => {
        const b = Buffer.from(j, "base64");
        return {
          gzip: z.gzipSync(b, { level: 6 }).length,
          z1: z.zstdCompressSync(b, at(1)).length,
          z3: z.zstdCompressSync(b).length,
          z19: z.zstdCompressSync(b, at(19)).length,
        };
      })));
    });`;
  const cmd = new Deno.Command("node", { args: ["-e", script], stdin: "piped", stdout: "piped", stderr: "piped" });
  const child = cmd.spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(JSON.stringify(samples.map(s => b64(s.data)))));
  await w.close();
  const { code, stdout, stderr } = await child.output();
  if (code !== 0) throw new Error(`node failed: ${new TextDecoder().decode(stderr)}`);
  return JSON.parse(new TextDecoder().decode(stdout));
}

const samples = await corpus();
console.log("## The corpus\n");
console.log(describe(samples));

const refs = await reference(samples);

console.log("\n## Compressed size\n");
console.log("| sample | raw | ours | gzip -6 | zstd -1 | zstd -3 | zstd -19 |");
console.log("|---|---:|---:|---:|---:|---:|---:|");
let totals = { raw: 0, ours: 0, gzip: 0, z1: 0, z3: 0, z19: 0 };
const rows: { name: string; ours: number; gzip: number; z3: number }[] = [];
for (let i = 0; i < samples.length; i++) {
  const s = samples[i];
  const t0 = performance.now();
  const ours = mod.compress(s.data).length;
  const ms = performance.now() - t0;
  const r = refs[i];
  console.log(`| ${s.name} | ${s.data.length} | ${ours} | ${r.gzip} | ${r.z1} | ${r.z3} | ${r.z19} |`);
  totals = {
    raw: totals.raw + s.data.length, ours: totals.ours + ours, gzip: totals.gzip + r.gzip,
    z1: totals.z1 + r.z1, z3: totals.z3 + r.z3, z19: totals.z19 + r.z19,
  };
  rows.push({ name: s.name, ours, gzip: r.gzip, z3: r.z3 });
  void ms;
}
console.log(`| **total** | **${totals.raw}** | **${totals.ours}** | **${totals.gzip}** | **${totals.z1}** | **${totals.z3}** | **${totals.z19}** |`);

console.log("\n## Where we stand, per sample\n");
console.log("| sample | vs gzip -6 | vs zstd -3 |");
console.log("|---|---:|---:|");
for (const r of rows) {
  const g = r.ours / r.gzip, z = r.ours / r.z3;
  console.log(`| ${r.name} | ${g < 1 ? "**" : ""}${g.toFixed(2)}x${g < 1 ? "**" : ""} | ${z < 1 ? "**" : ""}${z.toFixed(2)}x${z < 1 ? "**" : ""} |`);
}
console.log(`| **total** | ${(totals.ours / totals.gzip).toFixed(2)}x | ${(totals.ours / totals.z3).toFixed(2)}x |`);
console.log("\nUnder 1.00x is smaller than the reference. Bold marks where we win.");
