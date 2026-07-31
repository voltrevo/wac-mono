import { wacBind } from "../../../harness/wacBind.ts";
const mod = await wacBind("packages/fmt/src/ftoa.wac") as unknown as { ftoaBytes(x: number): Uint8Array };
const dec = new TextDecoder();
const view = new DataView(new ArrayBuffer(8));
let seed = 0xdeadbeef;
const next = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed; };
let checked = 0, bad = 0;
const N = 500000;
for (let i = 0; i < N; i++) {
  view.setUint32(0, next()); view.setUint32(4, next());
  const x = view.getFloat64(0);
  if (!Number.isFinite(x)) continue;
  checked++;
  const got = dec.decode(mod.ftoaBytes(x));
  if (got !== String(x)) { if (bad < 5) console.log(`MISMATCH ${String(x)} -> ${got}`); bad++; }
}
console.log(`${checked} finite doubles checked, ${bad} mismatches`);

// Parsing, the other direction: every shortest form must read back exactly.
const atofMod = await wacBind("packages/fmt/test/atof_probe.wac") as unknown as {
  parse(b: Uint8Array): number;
};
const enc = new TextEncoder();
let pChecked = 0, pBad = 0;
seed = 0x13579bdf;
for (let i = 0; i < 100000; i++) {
  view.setUint32(0, next()); view.setUint32(4, next());
  const x = view.getFloat64(0);
  if (!Number.isFinite(x)) continue;
  pChecked++;
  const s = String(x);
  const got = atofMod.parse(enc.encode(s));
  if (!Object.is(got, x)) { if (pBad < 5) console.log(`PARSE MISMATCH ${s} -> ${got}`); pBad++; }
}
console.log(`${pChecked} decimals parsed, ${pBad} mismatches`);
