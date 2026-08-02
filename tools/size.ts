// What the Tor client costs, compiled.
//
//   deno task size
//
// The layers are compiled separately and each pulls its own dependencies, so they do not
// sum to the total — TLS and the Tor protocol share most of the crypto, and the shared part
// is counted twice if you add them up. The interesting numbers are the total and the gap
// between it and each layer.

import { wacCompile } from "wac/wacCompile.ts";
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

console.log("layer".padEnd(38) + "  wasm".padStart(12) + "     gzipped");
console.log("-".repeat(64));
for (const [entry, label] of TARGETS) {
  const files = await wacFiles(entry);
  const r = await wacCompile(files as never, entry) as
    { ok: boolean; compiled?: { wasm: Uint8Array } };
  if (!r.ok || r.compiled === undefined) {
    console.log(`${label.padEnd(38)}  did not compile`);
    continue;
  }
  const wasm = r.compiled.wasm;
  const gz = await gzip(wasm);
  console.log(
    label.padEnd(38) +
    `${(wasm.length / 1024).toFixed(1).padStart(8)} KiB` +
    `${(gz.length / 1024).toFixed(1).padStart(10)} KiB`,
  );
}
