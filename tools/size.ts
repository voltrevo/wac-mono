// What the Tor client costs: to ship, and to compile.
//
//   deno task size
//
// The layers are compiled separately and each pulls its own dependencies, so they do not
// sum to the total — TLS and the Tor protocol share most of the crypto, and the shared part
// is counted twice if you add them up. The interesting numbers are the total and the gap
// between it and each layer.
//
// Times are the median of five runs after a warm-up, so they measure the compiler rather
// than V8 deciding to optimise it. A genuinely cold run is roughly twice as slow: the first
// compile in a fresh process pays for the JIT as well as the work.

import { type CompileResult, wacCompile } from "wac/wacCompile.ts";
import { wacFiles } from "../harness/wacFiles.ts";

const gzip = async (b: Uint8Array) =>
  new Uint8Array(await new Response(
    new Blob([b as BlobPart]).stream().pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer());

const TARGETS: [string, string][] = [
  ["packages/tor/size/proto_only.wac", "cells + path selection, no crypto"],
  ["packages/tor/size/tor_only.wac", "tor protocol + its crypto"],
  ["packages/tor/size/tls_only.wac", "TLS 1.3 client + its crypto"],
  ["packages/tor/src/client_entry.wac", "the whole client"],
];

console.log(
  "layer".padEnd(36) + "     wasm     gzipped     lines    compile",
);
console.log("-".repeat(76));
const broken: string[] = [];
for (const [entry, label] of TARGETS) {
  // The compiler's own result type, not a local re-declaration of it. The one that was here said
  // `{ ok: boolean; compiled?: { wasm } }` and nothing else, so `warm.diagnostics` below — the whole
  // point of the "did not compile" branch — was a property the cast had thrown away. It printed
  // nothing, silently, in exactly the case this tool exists to report loudly.
  const warm: CompileResult = await wacCompile(await wacFiles(entry), entry);
  if (!warm.ok || warm.compiled === undefined) {
    // Loudly, and non-zero at the end. A size report that prints "did not compile" and
    // exits 0 is green to everything that checks exit codes while measuring nothing —
    // three of these four layers were broken for some time and this is what said so.
    console.log(`${label.padEnd(36)}  did not compile`);
    for (const d of warm.diagnostics ?? []) {
      console.log(`    ${d.file}:${d.line}:${d.col} [${d.phase}] ${d.message}`);
    }
    broken.push(entry);
    continue;
  }

  const times: number[] = [];
  let lines = 0;
  for (let i = 0; i < 5; i++) {
    const files = await wacFiles(entry) as Map<string, string>;
    if (i === 0) {
      lines = [...files.values()].reduce((n, src) => n + src.split("\n").length, 0);
    }
    const t0 = performance.now();
    await wacCompile(files, entry);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);

  const wasm = warm.compiled.wasm;
  const gz = await gzip(wasm);
  console.log(
    label.padEnd(36) +
    `${(wasm.length / 1024).toFixed(1).padStart(8)} KiB` +
    `${(gz.length / 1024).toFixed(1).padStart(9)} KiB` +
    `${String(lines).padStart(10)}` +
    `${times[2].toFixed(0).padStart(9)} ms`,
  );
}

if (broken.length > 0) {
  console.error(`\n${broken.length} of ${TARGETS.length} layers did not compile:`);
  for (const b of broken) console.error(`  ${b}`);
  Deno.exit(1);
}
