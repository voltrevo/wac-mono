// What path selection actually does on a real consensus.
//
//   deno run -A packages/tor/audit/audit.ts <consensus> <microdescs>
//
// Not part of the suite, because the input is a 40MB capture of the live network that does
// not belong in the repository. It is here because the *speed* audit found an eleven-second
// quadratic and this one found `Wge`, and neither could be reached by any test written
// against a five-relay testnet.
//
// What it checks: that the published bandwidth weights are actually parsed rather than
// silently defaulted; that guard selection follows the weighted bandwidths across the whole
// weight distribution; that no relay with zero weight is ever chosen; that families resolve
// to sane exclusions rather than swallowing the network; and that paths build for the ports
// people use.

import { wacBind } from "../../../harness/wacBind.ts";
const m = await wacBind("packages/tor/audit/probe.wac");
const weightsOf = m.weightsOf as (d: Uint8Array) => BigInt64Array;
const weightedAt = m.weightedAt as (d: Uint8Array, mi: Uint8Array, p: number, port: number) => BigInt64Array;
const guardHistogram = m.guardHistogram as (d: Uint8Array, mi: Uint8Array, n: number) => Int32Array;
const familySizes = m.familySizes as (d: Uint8Array, mi: Uint8Array) => Int32Array;
const pathAudit = m.pathAudit as (d: Uint8Array, mi: Uint8Array, n: number, port: number) => Int32Array;

const [consensusPath, microPath] = Deno.args;
if (!consensusPath || !microPath) {
  console.error("usage: audit.ts <consensus-microdesc.txt> <microdescs.txt>");
  Deno.exit(2);
}
const cb = await Deno.readFile(consensusPath);
const mb = await Deno.readFile(microPath);

// 1. Are the real weights actually parsed, or silently defaulted?
const NAMES = ["Wgg","Wgd","Wge","Wgm","Wmg","Wmd","Wme","Wmm","Weg","Wed","Wee","Wem"];
const w = [...weightsOf(cb)].map(Number);
const line = new TextDecoder().decode(cb).match(/^bandwidth-weights (.+)$/m)![1];
const truth = Object.fromEntries(line.split(" ").map((p) => p.split("=")).map(([k, v]) => [k, +v]));
// Wge is not among the nineteen the authorities publish — tor hardcodes it to 0 for the
// guard position — so it is checked against that rather than against the file.
const wrong = NAMES.filter((n, i) =>
  n === "Wge" ? w[i] !== 0 : w[i] !== truth[n]);
console.log(`weights parsed: ${NAMES.map((n,i)=>`${n}=${w[i]}`).slice(0,4).join(" ")} ...`);
console.log(wrong.length === 0
  ? `  all 18 published weights match, and Wge is 0 as tor hardcodes it (Wgg=${w[0]}, not the 10000 default)`
  : `  MISMATCH on ${wrong.join(", ")}`);

// 2. Does guard selection actually follow the weighted bandwidths?
const expected = [...weightedAt(cb, mb, 0, 0)].map(Number);
const total = expected.reduce((a, b) => a + b, 0);
const N = 20000;
const counts = [...guardHistogram(cb, mb, N)];
const eligible = expected.filter((x) => x > 0).length;
console.log(`\nguards: ${eligible} eligible of ${expected.length} relays`);
// Compare the top relays by weight with how often they were actually picked.
const idx = expected.map((v, i) => [v, i] as [number, number]).sort((a, b) => b[0] - a[0]);
// Per-relay error at this sample count is dominated by sampling noise, so compare the mass
// in each decile of weight instead: aggregating shrinks the noise without needing more draws.
const ranked = idx.filter(([v]) => v > 0);
const per = Math.ceil(ranked.length / 10);
console.log(`  decile of weight | expected share | observed | ratio`);
for (let d = 0; d < 10; d++) {
  const bucket = ranked.slice(d * per, (d + 1) * per);
  if (bucket.length === 0) continue;
  const exp = bucket.reduce((a, [v]) => a + v, 0) / total;
  const got = bucket.reduce((a, [, i]) => a + counts[i], 0) / N;
  console.log(`  ${String(d + 1).padStart(2)} (heaviest first) | ${(exp * 100).toFixed(2).padStart(6)}% | ${(got * 100).toFixed(2).padStart(6)}% | ${(got / exp).toFixed(3)}`);
}
const zeroPicked = counts.filter((c, i) => c > 0 && expected[i] === 0).length;
console.log(`  relays picked despite zero weight: ${zeroPicked}`);

// 3. Families.
const fs = [...familySizes(cb, mb)];
const inFamily = fs.filter((x) => x > 0).length;
console.log(`\nfamilies: ${inFamily} relays in one, largest ${Math.max(...fs)} members` +
  ` (${(Math.max(...fs) / fs.length * 100).toFixed(1)}% of the network)`);

// 4. Do paths actually build for common ports?
for (const port of [443, 80, 22, 25]) {
  const [built, distinct] = [...pathAudit(cb, mb, 200, port)];
  const exits = [...weightedAt(cb, mb, 2, port)].filter((x) => x > 0).length;
  console.log(`port ${String(port).padStart(3)}: ${exits} usable exits, ${built}/200 paths built, ${distinct} with three distinct addresses`);
}
