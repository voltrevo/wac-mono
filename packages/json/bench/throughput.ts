// Throughput by document shape, so a slow path can be attributed rather than
// guessed at.
//
// One aggregate number over "realistic JSON" hides everything: a parser can be
// fast on structure and slow on strings and still look fine. Each corpus below
// isolates one path, and the ratios between them are the useful part.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/json/src/json.wac") as unknown as {
  canonicalize(src: Uint8Array): Uint8Array;
  errorCode(src: Uint8Array): number;
};

const MIB = 1048576;

/** Repeat `unit` inside an array until the document is about `target` bytes. */
function corpus(unit: string, target = MIB): string {
  const parts: string[] = [];
  let size = 2;
  while (size < target) { parts.push(unit); size += unit.length + 1; }
  return `[${parts.join(",")}]`;
}

const SHAPES: [string, string][] = [
  ["structure only (nested empties)", corpus("[[],{},[{}]]")],
  ["small integers", corpus("1,22,333,4444,55555,666666")],
  ["simple decimals", corpus("1.5,2.25,3.125,-4.0625,0.5")],
  ["exponent-form numbers", corpus("1e10,2.5e-8,3.75e100,-1.25e-300")],
  ["long-mantissa numbers", corpus("1.2345678901234567890123,9.87654321098765432109e-45")],
  ["short ASCII strings", corpus('"alpha","beta","gamma","delta"')],
  ["long ASCII strings", corpus(`"${"x".repeat(200)}"`)],
  ["strings with escapes", corpus('"a\\nb\\tc\\"d\\\\e","f\\u0041g"')],
  ["multi-byte UTF-8 strings", corpus('"日本語テキスト","café naïve","😀😀😀"')],
  ["objects, short keys", corpus('{"a":1,"b":2,"c":3,"d":4}')],
  ["objects, long keys", corpus('{"aaaaaaaaaaaaaaaaaaaa":1,"bbbbbbbbbbbbbbbbbbbb":2}')],
  ["realistic mixed", corpus('{"id":1234,"name":"item-1234","score":98.6,"tags":["a","b"],"ok":true,"note":null}')],
];

const enc = new TextEncoder();

console.log("| shape | MB/s | ms |");
console.log("|---|---:|---:|");
for (const [label, text] of SHAPES) {
  const bytes = enc.encode(text);
  for (let i = 0; i < 3; i++) mod.canonicalize(bytes);
  let best = Infinity;
  for (let i = 0; i < 7; i++) {
    const t0 = performance.now();
    const out = mod.canonicalize(bytes);
    const dt = performance.now() - t0;
    if (out[0] !== 0) throw new Error(`${label}: parse failed with code ${out[0]}`);
    best = Math.min(best, dt);
  }
  const mbps = bytes.length / MIB / (best / 1000);
  console.log(`| ${label} | ${mbps.toFixed(1)} | ${best.toFixed(1)} |`);
}

// Parsing alone, without building the output — separates scan cost from emit cost.
console.log("\n| shape | parse-only MB/s |");
console.log("|---|---:|");
for (const [label, text] of SHAPES) {
  const bytes = enc.encode(text);
  for (let i = 0; i < 3; i++) mod.errorCode(bytes);
  let best = Infinity;
  for (let i = 0; i < 7; i++) {
    const t0 = performance.now();
    mod.errorCode(bytes);
    best = Math.min(best, performance.now() - t0);
  }
  console.log(`| ${label} | ${(bytes.length / MIB / (best / 1000)).toFixed(1)} |`);
}
